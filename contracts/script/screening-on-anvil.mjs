#!/usr/bin/env node
// square#35, end to end: the real screener service, TRM's real answers, and the
// real hook on a local chain.
//
//   A  screened clean      the screener clears the client and a provider
//   B  funded              and the job funds
//   C  designated provider an address on OFAC's SDN list cannot be funded:
//                          fund reverts NotCleared, and nothing enters escrow
//   D  designated buyer    a receivable sold to an SDN-listed buyer is not paid
//                          to it at release; the net goes back to the client
//   E  honest release      the payee screened just before finalize is paid
//   F  canary              a screener started with a canary the source does not
//                          flag signs nothing and records nothing
//
// The SDN-listed addresses are three from OFAC's Lazarus Group designation (the
// Ronin bridge theft). The run does not assume they are still listed: it asks TRM,
// and a check fails if TRM stopped flagging them. They act on anvil through
// impersonation, which is anvil's, not theirs.
//
//   anvil &
//   INSTALL_SCREENING=true forge script script/DeployLocal.s.sol --rpc-url … --broadcast   (or without; the run installs it)
//   (cd ../services/screener && npm run build)
//   node script/screening-on-anvil.mjs
//
// Five requests to TRM, of the 100 a day its keyless tier allows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const RPC = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';

const coreRequire = createRequire(path.join(REPO, 'packages', 'core', 'package.json'));
const VIEM = path.dirname(coreRequire.resolve('viem/package.json'));
const {
  createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseEventLogs, parseUnits, zeroHash,
} = await import(pathToFileURL(path.join(VIEM, '_esm', 'index.js')).href);
const { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } = await import(
  pathToFileURL(path.join(VIEM, '_esm', 'accounts', 'index.js')).href
);
const { foundry } = await import(pathToFileURL(path.join(VIEM, '_esm', 'chains', 'index.js')).href);

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const CANARY = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
const DESIGNATED_PROVIDER = '0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073';
const DESIGNATED_BUYER = '0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1';

let failures = 0;
function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    process.stdout.write(`  FAIL  ${name}\n        expected ${expected}\n        got      ${actual}\n`);
    failures += 1;
  }
}

function abiOf(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'out', `${name}.sol`, `${name}.json`), 'utf8')).abi;
}

async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const walletOf = (account) => createWalletClient({ chain: foundry, transport: http(RPC), account });
const anvil = (index) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });

async function send(account, address, abi, functionName, args = []) {
  const hash = await walletOf(account).writeContract({ address, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}

// An address anvil lets us act as, for the addresses whose keys nobody here holds.
async function asImpersonated(address, fn) {
  await rpc('anvil_impersonateAccount', [address]);
  await rpc('anvil_setBalance', [address, '0xde0b6b3a7640000']);
  try {
    return await fn({ address, type: 'json-rpc' });
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [address]);
  }
}

function startScreener({ port, canary, registry, key }) {
  const child = spawn(process.execPath, [path.join(REPO, 'services', 'screener', 'dist', 'main.js')], {
    env: {
      ...process.env, RPC_URL: RPC, CHAIN_ID: '31337', SCREENING_REGISTRY: registry,
      SCREENER_PRIVATE_KEY: key, SCREENING_CANARY: canary, PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never answered`);
}

async function screen(port, addresses) {
  const response = await fetch(`http://127.0.0.1:${port}/screen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses }),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  if (Number(BigInt(await rpc('eth_chainId'))) !== 31337) throw new Error(`${RPC} is not a local anvil`);
  await rpc('anvil_nodeInfo');
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', '31337.json'), 'utf8'));
  // The hook's errors reach the caller through the kernel, so fund is called
  // with both, and a NotCleared revert decodes by name.
  const kernelAbi = [...abiOf('SquareJob'), ...abiOf('SquareHook').filter((e) => e.type === 'error')];
  const keeperAbi = abiOf('KeeperEvaluator');
  const hookAbi = abiOf('SquareHook');
  const registryAbi = abiOf('ScreeningRegistry');
  const marketAbi = abiOf('ClaimMarket');
  const usdcAbi = abiOf('MockUSDC');
  const validationAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'MockRegistries.sol', 'MockValidationRegistry.json'), 'utf8')).abi;
  const owner = anvil(0);
  const client = anvil(1);
  const provider = anvil(2);
  const cranker = anvil(7);
  const screenerKey = generatePrivateKey();
  const screener = privateKeyToAccount(screenerKey);

  // Wire it: the hook reads the registry, the registry trusts this screener, and
  // the screener can pay for its submissions.
  if ((await publicClient.readContract({ address: d.SquareHook, abi: hookAbi, functionName: 'screening' })).toLowerCase() !== d.ScreeningRegistry.toLowerCase()) {
    await send(owner, d.SquareHook, hookAbi, 'setScreening', [d.ScreeningRegistry]);
  }
  await send(owner, d.ScreeningRegistry, registryAbi, 'setScreener', [screener.address, true]);
  await publicClient.waitForTransactionReceipt({ hash: await walletOf(owner).sendTransaction({ to: screener.address, value: 10n ** 18n }) });
  const cleared = (who) => publicClient.readContract({ address: d.ScreeningRegistry, abi: registryAbi, functionName: 'isCleared', args: [who] });
  const record = (who) => publicClient.readContract({ address: d.ScreeningRegistry, abi: registryAbi, functionName: 'screeningOf', args: [who] });

  const services = [startScreener({ port: 3112, canary: CANARY, registry: d.ScreeningRegistry, key: screenerKey })];
  const timings = [];
  try {
    await waitFor('http://127.0.0.1:3112/health');
    process.stdout.write(`screener ${screener.address} on :3112, canary ${CANARY}\nregistry ${d.ScreeningRegistry}, hook ${d.SquareHook}\n\n`);

    const budget = parseUnits('50', 6);
    const expiry = async () => (await publicClient.getBlock()).timestamp + 30n * 86_400n;
    const createJob = async (providerAddress) => {
      const receipt = await send(client, d.SquareJob, kernelAbi, 'createJob',
        [providerAddress, d.KeeperEvaluator, await expiry(), 'square#35', d.SquareHook]);
      return parseEventLogs({ abi: kernelAbi, logs: receipt.logs, eventName: 'JobCreated' })[0].args.jobId;
    };
    await send(client, d.USDC, usdcAbi, 'approve', [d.SquareJob, budget * 10n]);

    process.stdout.write('A  the screener clears the client and a provider\n');
    const a = await screen(3112, [client.address, provider.address]);
    check('answered 200', a.status, 200);
    check('neither is designated', a.body.screenings?.map((s) => s.sanctioned).join(), 'false,false');
    check('the client is cleared on chain', await cleared(client.address), true);
    check('so is the provider', await cleared(provider.address), true);

    process.stdout.write('\nB  a job between them funds\n');
    const clean = await createJob(provider.address);
    await send(provider, d.SquareJob, kernelAbi, 'setBudget', [clean, budget, '0x']);
    await send(client, d.SquareJob, kernelAbi, 'fund', [clean, budget, '0x']);
    check('funded', (await publicClient.readContract({ address: d.SquareJob, abi: kernelAbi, functionName: 'getJobRecord', args: [clean] })).status, 1);

    process.stdout.write(`\nC  a provider on OFAC's SDN list: ${DESIGNATED_PROVIDER}\n`);
    const blocked = await createJob(DESIGNATED_PROVIDER);
    await asImpersonated(DESIGNATED_PROVIDER, (acting) => send(acting, d.SquareJob, kernelAbi, 'setBudget', [blocked, budget, '0x']));
    const c = await screen(3112, [DESIGNATED_PROVIDER]);
    check('TRM flags it, and the screener records that', c.body.screenings?.[0]?.sanctioned, true);
    check('the registry holds it as sanctioned', (await record(DESIGNATED_PROVIDER)).sanctioned, true);
    const before = await publicClient.readContract({ address: d.USDC, abi: usdcAbi, functionName: 'balanceOf', args: [client.address] });
    let reverted;
    try {
      await send(client, d.SquareJob, kernelAbi, 'fund', [blocked, budget, '0x']);
    } catch (error) {
      reverted = error.walk((e) => e?.data?.errorName)?.data;
    }
    check('funding reverts: NotCleared', reverted?.errorName, 'NotCleared');
    check('naming the designated provider, not the client', reverted?.args?.[0]?.toLowerCase(), DESIGNATED_PROVIDER.toLowerCase());
    check('and the client still holds its USDC',
      await publicClient.readContract({ address: d.USDC, abi: usdcAbi, functionName: 'balanceOf', args: [client.address] }), before);

    process.stdout.write(`\nD  the receivable sold to a buyer on OFAC's SDN list: ${DESIGNATED_BUYER}\n`);
    // The provider owns agent 1 and names the hook as the validator of this job,
    // so the hook's verdict on the release is written to the ERC-8004 registry.
    const requestD = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [clean, 'square#35 D']));
    await send(provider, d.ValidationRegistry, validationAbi, 'validationRequest', [d.SquareHook, 1n, '', requestD]);
    await send(provider, d.SquareJob, kernelAbi, 'submit',
      [clean, keccak256('0x3335'), encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [1n, requestD])]);
    const price = budget / 2n;
    await send(provider, d.ClaimMarket, marketAbi, 'list', [clean, price]);
    await send(owner, d.USDC, usdcAbi, 'mint', [DESIGNATED_BUYER, price]);
    const buyInputs = marketAbi.find((e) => e.type === 'function' && e.name === 'buy').inputs.length;
    await asImpersonated(DESIGNATED_BUYER, async (acting) => {
      await send(acting, d.USDC, usdcAbi, 'approve', [d.ClaimMarket, price]);
      if (buyInputs === 2) return send(acting, d.ClaimMarket, marketAbi, 'buy', [clean, price]);
      // After #30: the client has to approve the buyer first, a list of one.
      const salt = keccak256(generatePrivateKey());
      const root = keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [DESIGNATED_BUYER, salt])));
      await send(client, d.PolicyRegistry, abiOf('PolicyRegistry'), 'setBuyerRoot', [root]);
      return send(acting, d.ClaimMarket, marketAbi, 'buy', [clean, price, salt, []]);
    });
    check('the buyer is the payee', (await publicClient.readContract({ address: d.ClaimMarket, abi: marketAbi, functionName: 'payeeOf', args: [clean] })).toLowerCase(), DESIGNATED_BUYER.toLowerCase());
    const end = await publicClient.readContract({ address: d.KeeperEvaluator, abi: keeperAbi, functionName: 'challengeEndsAt', args: [clean] });
    await rpc('evm_setNextBlockTimestamp', [Number(end) + 1]);
    await rpc('evm_mine');
    const dScreen = await screen(3112, [DESIGNATED_BUYER]);
    check('TRM flags the buyer', dScreen.body.screenings?.[0]?.sanctioned, true);
    timings.push(['D  buyer, before release', dScreen.body.timings]);
    // So the refusal below is this record's doing, not a missing one's.
    check('the registry holds the buyer as sanctioned, freshly', (await record(DESIGNATED_BUYER)).sanctioned, true);
    const withdrawable = (who) => publicClient.readContract({ address: d.SquareJob, abi: kernelAbi, functionName: 'withdrawable', args: [who] });
    const clientBefore = await withdrawable(client.address);
    const net = await publicClient.readContract({ address: d.SquareJob, abi: kernelAbi, functionName: 'netPayout', args: [clean] });
    const fin = await send(cranker, d.KeeperEvaluator, keeperAbi, 'finalize', [clean, '0x']);
    const checked = parseEventLogs({ abi: hookAbi, logs: fin.logs, eventName: 'ScreeningChecked' })[0];
    check('the hook saw the payee not cleared', checked?.args.cleared, false);
    check('the buyer is paid nothing', await withdrawable(DESIGNATED_BUYER), 0n);
    check('the net went back to the client', (await withdrawable(client.address)) - clientBefore, net);
    const [, , dResponse, , dTag] = await publicClient.readContract({ address: d.ValidationRegistry, abi: validationAbi, functionName: 'getValidationStatus', args: [requestD] });
    check('the ERC-8004 record attests the refusal: response 0', dResponse, 0);
    check('under the hook\'s tag', dTag, 'square.compliance');

    process.stdout.write('\nE  the honest release: the payee screened just before finalize\n');
    await screen(3112, [client.address]);
    const honest = await createJob(provider.address);
    await send(provider, d.SquareJob, kernelAbi, 'setBudget', [honest, budget, '0x']);
    const refresh = await screen(3112, [provider.address]);
    check('the provider is screened again, and clean', refresh.body.screenings?.[0]?.sanctioned, false);
    await send(client, d.SquareJob, kernelAbi, 'fund', [honest, budget, '0x']);
    const requestE = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [honest, 'square#35 E']));
    await send(provider, d.ValidationRegistry, validationAbi, 'validationRequest', [d.SquareHook, 1n, '', requestE]);
    await send(provider, d.SquareJob, kernelAbi, 'submit',
      [honest, keccak256('0x3336'), encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [1n, requestE])]);
    const honestEnd = await publicClient.readContract({ address: d.KeeperEvaluator, abi: keeperAbi, functionName: 'challengeEndsAt', args: [honest] });
    await rpc('evm_setNextBlockTimestamp', [Number(honestEnd) + 1]);
    await rpc('evm_mine');
    const again = await screen(3112, [provider.address]);
    check('screened at release', again.status, 200);
    timings.push(['E  provider, before release', again.body.timings]);
    const providerBefore = await withdrawable(provider.address);
    const paid = await send(cranker, d.KeeperEvaluator, keeperAbi, 'finalize', [honest, '0x']);
    check('the hook saw the payee cleared', parseEventLogs({ abi: hookAbi, logs: paid.logs, eventName: 'ScreeningChecked' })[0]?.args.cleared, true);
    check('the provider is paid the net',
      (await withdrawable(provider.address)) - providerBefore,
      await publicClient.readContract({ address: d.SquareJob, abi: kernelAbi, functionName: 'netPayout', args: [honest] }));
    const [, , eResponse] = await publicClient.readContract({ address: d.ValidationRegistry, abi: validationAbi, functionName: 'getValidationStatus', args: [requestE] });
    check('the ERC-8004 record attests the release: response 100', eResponse, 100);

    process.stdout.write('\nF  a screener whose canary the source does not flag\n');
    const notDesignated = privateKeyToAccount(generatePrivateKey()).address;
    services.push(startScreener({ port: 3113, canary: notDesignated, registry: d.ScreeningRegistry, key: screenerKey }));
    await waitFor('http://127.0.0.1:3113/health');
    const recordedBefore = (await record(client.address)).screenedAt;
    const f = await screen(3113, [client.address]);
    check('it refuses: 503', f.status, 503);
    check('and says why', /did not flag the canary/.test(f.body.error ?? ''), true);
    check('nothing was recorded', (await record(client.address)).screenedAt, recordedBefore);
    process.stdout.write('\nthe screening a release waits for, as the screener measured it\n');
    for (const [label, t] of timings) {
      process.stdout.write(`  ${label.padEnd(28)} source ${String(t?.sourceMs).padStart(5)} ms   submit ${String(t?.submitMs).padStart(5)} ms\n`);
    }
  } finally {
    for (const child of services) child.kill();
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write('\nScreened addresses stop settlement at both points, and a source that fails its canary attests nothing.\n');
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
