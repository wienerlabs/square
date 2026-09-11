#!/usr/bin/env node
// square#35: what screening at release costs in time. The issue names it: the
// check before money leaves "adds latency". This measures it with the real
// screener service against a real chain: a request is TRM's answer, then one
// submission to ScreeningRegistry until its receipt.
//
// It deploys its own ScreeningRegistry, registers a screener key drawn for the
// run, funds it, starts services/screener against the chain, and screens an
// address nobody has used together with an address on OFAC's SDN list, three
// times. Each answer is read back from the chain before it is counted.
//
//   anvil:  node script/screening-latency.mjs
//   Arc:    SCENARIO_RPC_URL=https://rpc.testnet.arc.io \
//           SCENARIO_FUNDER_PRIVATE_KEY=0x… node script/screening-latency.mjs
//
// Needs services/screener built. Three requests to TRM.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const RPC = process.env.SCENARIO_RPC_URL ?? 'http://127.0.0.1:8545';
const ROUNDS = 3;
// Overridable, so a run against anvil and one against Arc can share a machine.
const PORT = Number(process.env.SCREENER_PORT ?? 3120);
const CANARY = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
const DESIGNATED = '0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073';

const coreRequire = createRequire(path.join(REPO, 'packages', 'core', 'package.json'));
const VIEM = path.dirname(coreRequire.resolve('viem/package.json'));
const { createPublicClient, createWalletClient, defineChain, formatUnits, http } = await import(pathToFileURL(path.join(VIEM, '_esm', 'index.js')).href);
const { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } = await import(pathToFileURL(path.join(VIEM, '_esm', 'accounts', 'index.js')).href);
const { ANVIL_CHAIN_ID, ARC_TESTNET_CHAIN_ID, deploymentFor, networkFor } = await import(pathToFileURL(path.join(REPO, 'packages', 'core', 'dist', 'index.js')).href);

async function rpc(method, params = []) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const artifact = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
let failures = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${expected}\n        got      ${actual}`}\n`);
  if (!ok) failures += 1;
}

async function main() {
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  const devNode = await rpc('anvil_nodeInfo').then(() => true, () => false);
  const client = await rpc('web3_clientVersion').catch(() => 'unknown');
  let funder;
  let gasIsUsdc = false;
  let explorer;
  if (chainId === ANVIL_CHAIN_ID && devNode) {
    funder = mnemonicToAccount('test test test test test test test test test test test junk');
  } else if (chainId === ARC_TESTNET_CHAIN_ID && !devNode) {
    if (!process.env.SCENARIO_FUNDER_PRIVATE_KEY) throw new Error('SCENARIO_FUNDER_PRIVATE_KEY is required on Arc');
    funder = privateKeyToAccount(process.env.SCENARIO_FUNDER_PRIVATE_KEY);
    gasIsUsdc = true;
    explorer = networkFor(chainId).explorerUrl;
  } else {
    throw new Error(`${RPC} is chain ${chainId}${devNode ? ' (a development node)' : ''}; this knows anvil and Arc Testnet only`);
  }
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: gasIsUsdc ? 'USDC' : 'Ether', symbol: gasIsUsdc ? 'USDC' : 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const wallet = (account) => createWalletClient({ chain, transport: http(RPC), account });
  const mined = async (hash) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return receipt;
  };
  process.stdout.write(`chain    ${chainId} (${client})\nfunder   ${funder.address}\n`);

  const registryArtifact = artifact('ScreeningRegistry');
  const deployed = await mined(await wallet(funder).deployContract({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode.object, args: [funder.address, 3600n] }));
  const registry = deployed.contractAddress;
  const screenerKey = generatePrivateKey();
  const screener = privateKeyToAccount(screenerKey);
  await mined(await wallet(funder).writeContract({ address: registry, abi: registryArtifact.abi, functionName: 'setScreener', args: [screener.address, true] }));
  const usdcAbi = artifact('MockUSDC').abi;
  const usdc = gasIsUsdc ? deploymentFor(chainId).usdc : null;
  if (gasIsUsdc) {
    await mined(await wallet(funder).writeContract({ address: usdc, abi: usdcAbi, functionName: 'transfer', args: [screener.address, 50_000n] }));
  } else {
    await mined(await wallet(funder).sendTransaction({ to: screener.address, value: 10n ** 18n }));
  }
  process.stdout.write(`registry ${registry}\nscreener ${screener.address}\n\n`);

  const service = spawn(process.execPath, [path.join(REPO, 'services', 'screener', 'dist', 'main.js')], {
    env: { ...process.env, RPC_URL: RPC, CHAIN_ID: String(chainId), SCREENING_REGISTRY: registry, SCREENER_PRIVATE_KEY: screenerKey, SCREENING_CANARY: CANARY, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const rows = [];
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).status < 500) break; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (let round = 1; round <= ROUNDS; round += 1) {
      // A second apart, for two reasons. TRM's keyless tier allows one request a
      // second. And every round screens the same SDN-listed address again, while
      // the registry keeps a record only if it is strictly newer than the one it
      // holds. Two rounds in one second of chain time would give the second the
      // same timestamp, the registry would refuse it, and the screener would
      // answer 502. That is the registry doing its job, not a cost of screening.
      if (round > 1) await new Promise((resolve) => setTimeout(resolve, 1_100));
      const unused = privateKeyToAccount(generatePrivateKey()).address;
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${PORT}/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses: [unused, DESIGNATED] }) });
      const roundTripMs = Math.round(performance.now() - started);
      const body = await response.json();
      process.stdout.write(`round ${round}\n`);
      check('answered 200', response.status, 200);
      const cleared = await publicClient.readContract({ address: registry, abi: registryArtifact.abi, functionName: 'isCleared', args: [unused] });
      const designated = await publicClient.readContract({ address: registry, abi: registryArtifact.abi, functionName: 'screeningOf', args: [DESIGNATED] });
      check('the unused address is cleared on chain', cleared, true);
      check('the SDN-listed address is recorded as sanctioned', designated.sanctioned, true);
      rows.push({ round, ...body.timings, roundTripMs, tx: body.transactionHash });
    }
  } finally {
    service.kill();
  }

  process.stdout.write('\nround   source (TRM)   submit (to receipt)   round trip\n');
  for (const r of rows) {
    process.stdout.write(`  ${r.round}     ${String(r.sourceMs).padStart(6)} ms     ${String(r.submitMs).padStart(9)} ms       ${String(r.roundTripMs).padStart(6)} ms   ${explorer ? `${explorer}/tx/${r.tx}` : r.tx}\n`);
  }
  if (gasIsUsdc) {
    const left = await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [screener.address] });
    const gas = await publicClient.estimateContractGas({ account: screener, address: usdc, abi: usdcAbi, functionName: 'transfer', args: [funder.address, 1n] });
    const reserve = (gas * (await publicClient.getGasPrice()) * 2n) / 10n ** 12n;
    if (left > reserve) await mined(await wallet(screener).writeContract({ address: usdc, abi: usdcAbi, functionName: 'transfer', args: [funder.address, left - reserve] }));
    process.stdout.write(`\nreturned ${formatUnits(left > reserve ? left - reserve : 0n, 6)} USDC from the screener to the funder\n`);
  }
  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
