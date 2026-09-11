#!/usr/bin/env node
// square#28: the six scenarios of a compliance-gated release, from the prover
// to the chain, on anvil or on Arc Testnet.
//
//   1  compliant             a proof is built, the release pays the provider
//   2  over the daily cap    the circuit emits is_compliant = 0
//   3  blocked recipient     the circuit emits is_compliant = 0
//   4  policy replaced       an old proof no longer matches the commitment
//   5  outside the window    the proof claims an allowed hour; the chain's
//                            clock says otherwise
//   6  another job's proof   a valid proof presented against a different job
//
// "Refused" means what docs/decisions/hook-failure-modes.md made it mean. The
// issue was written as "complete reverts", and #100 closed that door: the
// kernel tolerates a hook failure, because a hook that could revert left the
// escrow with no exit at all. A refusal is the payout split with providerBps
// = 0, so the job settles, the provider is paid nothing, the whole net goes
// back to the client, and the module names its reason in ReleaseRefused. Every
// refusal below is asserted by that reason, so a job refused for the wrong
// reason fails the run.
//
// The run deploys everything it touches: a settlement stack with a short
// challenge window, a PolicyRegistry, the repository's verifier compiled with
// this build's key, and a ComplianceModule bound to it. The same code path
// runs on both chains. On Arc that is required, because the shared stack's
// owner key is not something a CI run holds, and because CI builds a
// development proving key with random phase-2 entropy, so a verifier from any
// other build rejects every proof this run makes. The ungated baseline is
// finalized before the module is installed, so the gate's cost is a measured
// difference.
//
// Every actor except the funder is a key drawn for this run. The funder
// deploys, owns, cranks and pays; whatever the actors hold is swept back to it
// at the end. After a failure the run first settles the jobs it left open and
// then sweeps, so their budgets come back too.
//
//   anvil:  anvil --silent &
//           node script/refusal-scenarios.mjs
//   Arc:    SCENARIO_RPC_URL=https://rpc.testnet.arc.io \
//           SCENARIO_FUNDER_PRIVATE_KEY=0x… node script/refusal-scenarios.mjs
//
// Needs `forge`, the circuit artifacts (PROVER_ARTIFACTS_DIR, or
// services/prover/artifacts), and packages/core built, for viem and the
// network profile.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');

const RPC = process.env.SCENARIO_RPC_URL ?? 'http://127.0.0.1:8545';
const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.join(REPO, 'services', 'prover', 'artifacts');
const VK = path.join(ARTIFACTS, 'payment_vk.json');

// Short enough to wait out on a real chain, and long enough that the window is
// something the keeper actually waits for.
const CHALLENGE_WINDOW = Number(process.env.SCENARIO_CHALLENGE_WINDOW ?? 30);
const DISPUTE_WINDOW = 30;
const FINALIZE_GRACE = 30;
// The gap between building a proof and it being mined. Every second of it is a
// second in which a policy's time window can be straddled (compliance-gate.md),
// and scenario 5 claims a time hours away, so it is refused whatever this is.
const TOLERANCE_SECONDS = 600;
// The fee schedule the shared Arc stack runs with (deploy-arc-testnet.sh).
const PLATFORM_FEE_BP = 100;
const EVALUATOR_FEE_BP = 50;
const HOOK_GAS_LIMIT = 1_000_000n;
const MIN_REPUTATION_BUDGET = 1_000_000n;

// anvil's published development mnemonic, the one DeployLocal.s.sol derives
// from. Its keys guard nothing.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

const coreRequire = createRequire(path.join(REPO, 'packages', 'core', 'package.json'));
const VIEM = path.dirname(coreRequire.resolve('viem/package.json'));
const {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatUnits, hexToString,
  http, keccak256, parseEventLogs, stringToHex,
} = await import(pathToFileURL(path.join(VIEM, '_esm', 'index.js')).href);
const { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } = await import(
  pathToFileURL(path.join(VIEM, '_esm', 'accounts', 'index.js')).href
);
const { ANVIL_CHAIN_ID, ARC_TESTNET_CHAIN_ID, deploymentFor, networkFor } = await import(
  pathToFileURL(path.join(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const { buildCircuitInput, generateProof } = await import(
  pathToFileURL(path.join(REPO, 'services', 'prover', 'src', 'prover.js')).href
);
const { randomPolicySalt } = await import(
  pathToFileURL(path.join(REPO, 'services', 'prover', 'src', 'commitment.js')).href
);
const { policyDataHash } = await import(
  pathToFileURL(path.join(REPO, 'circuits', 'test', 'helpers', 'inputs.mjs')).href
);

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const usdc = (units) => `${formatUnits(units, 6)} USDC`;
const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const PROOF_ABI = [{ type: 'uint256[2]' }, { type: 'uint256[2][2]' }, { type: 'uint256[2]' }, { type: 'uint256[8]' }];

let failures = 0;
function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    process.stdout.write(`  FAIL  ${name}\n        expected ${expected}\n        got      ${actual}\n`);
    failures += 1;
  }
}

// ------------------------------------------------------------------ the chain

async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// Which chain answered, and what it lets this run do. A fork of Arc reports
// Arc's chain id, so the id alone is not enough: a development node answers
// anvil_nodeInfo and Arc does not (end-to-end-5042002.md, "Which chain
// answered"). A hostile RPC can still lie about both; the closing line names
// the client that answered so that is not taken on trust.
async function chainProfile() {
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  const devNode = await rpc('anvil_nodeInfo').then(() => true, () => false);
  const client = await rpc('web3_clientVersion').catch(() => 'unknown');
  if (chainId === ANVIL_CHAIN_ID) {
    if (!devNode) throw new Error(`${RPC} reports chain ${chainId} but is not anvil`);
    const key = process.env.SCENARIO_FUNDER_PRIVATE_KEY;
    return {
      chainId, client, name: 'anvil', gasIsUsdc: false, explorer: undefined,
      funder: key ? privateKeyToAccount(key) : mnemonicToAccount(ANVIL_MNEMONIC),
    };
  }
  if (chainId === ARC_TESTNET_CHAIN_ID) {
    if (devNode) {
      throw new Error(`${RPC} answers anvil_nodeInfo, so it is a development node reporting Arc's chain id, `
        + 'very likely a fork. This run is evidence about Arc; point it at Arc.');
    }
    const key = process.env.SCENARIO_FUNDER_PRIVATE_KEY;
    if (!key) {
      throw new Error('SCENARIO_FUNDER_PRIVATE_KEY is required on Arc: the account that deploys, owns, '
        + 'funds and cranks this run.');
    }
    const shared = deploymentFor(ARC_TESTNET_CHAIN_ID);
    return {
      chainId, client, name: networkFor(chainId).name, gasIsUsdc: true, explorer: networkFor(chainId).explorerUrl,
      funder: privateKeyToAccount(key),
      usdc: shared.usdc,
      registries: [shared.identityRegistry, shared.reputationRegistry, shared.validationRegistry],
    };
  }
  throw new Error(`${RPC} is chain ${chainId}; this run knows anvil (${ANVIL_CHAIN_ID}) and Arc Testnet `
    + `(${ARC_TESTNET_CHAIN_ID}) only`);
}

const env = { profile: undefined, publicClient: undefined, chain: undefined };
const ledger = [];

function wallet(account) {
  return createWalletClient({ account, chain: env.chain, transport: http(RPC) });
}

async function chainNow() {
  // anvil mines only when asked, so its latest block can be minutes old. Arc
  // produces blocks continuously.
  if (!env.profile.gasIsUsdc) await rpc('evm_mine');
  return (await env.publicClient.getBlock()).timestamp;
}

async function mined(hash, label) {
  const receipt = await env.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  ledger.push({ label, hash, gasUsed: receipt.gasUsed, price: receipt.effectiveGasPrice });
  return receipt;
}

async function send(account, contract, functionName, args, label = functionName) {
  const hash = await wallet(account).writeContract({ address: contract.address, abi: contract.abi, functionName, args });
  return mined(hash, label);
}

function read(contract, functionName, args = []) {
  return env.publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });
}

function artifact(file, name) {
  const out = path.join(ROOT, 'out', file, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(label, file, name, args) {
  const { abi, bytecode } = artifact(file, name);
  const hash = await wallet(env.profile.funder).deployContract({ abi, bytecode, args });
  const receipt = await mined(hash, `deploy ${label}`);
  return { address: receipt.contractAddress, abi };
}

const fee = (gasUsed, price) => gasUsed * price;
// Arc settles gas in USDC and reports it with 18 decimals natively; the ERC-20
// view of the same balance has 6 (docs/decisions/erc20-vs-native-usdc.md).
const nativeToUsdcUnits = (wei) => wei / 10n ** 12n;
const costLine = (gasUsed, price) => (env.profile.gasIsUsdc
  ? `${gasUsed} gas, ${usdc(nativeToUsdcUnits(fee(gasUsed, price)))}`
  : `${gasUsed} gas`);
const link = (hash) => (env.profile.explorer ? `${env.profile.explorer}/tx/${hash}` : hash);

// ------------------------------------------------------- the verifier for this build

// As #19 and #76 build it: the repository's verifier with this build's key
// constants. Only delta differs between builds, and a stale delta fails at the
// pairing with no diagnostic but `false`.
const GENERATED_DIR = path.join(ROOT, 'src', 'generated');
const GENERATED = path.join(GENERATED_DIR, 'VerifierForThisBuild.sol');

function compileVerifierForThisBuild() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'Groth16Verifier.sol'), 'utf8');
  const constants = execFileSync(
    process.execPath,
    [path.join(ROOT, 'script', 'verifier-constants.mjs'), VK],
    { encoding: 'utf8', timeout: 60_000 },
  ).trimEnd();
  const first = source.indexOf('    uint256 private constant ALPHA_X');
  const lastIc = source.lastIndexOf('    uint256 private constant IC');
  if (first < 0 || lastIc < 0) throw new Error('could not find the key constants in src/Groth16Verifier.sol');
  const end = source.indexOf('\n', lastIc) + 1;
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(
    GENERATED,
    (source.slice(0, first) + constants + '\n' + source.slice(end))
      .replace('contract Groth16Verifier {', 'contract VerifierForThisBuild {'),
  );
  execFileSync('forge', ['build'], { cwd: ROOT, stdio: 'ignore', timeout: 600_000 });
}

// ------------------------------------------------------------------ the stack

async function deployStack() {
  const { funder } = env.profile;
  const s = {};
  if (env.profile.gasIsUsdc) {
    s.usdc = { address: env.profile.usdc, abi: artifact('MockUSDC.sol', 'MockUSDC').abi };
    [s.identity, s.reputation, s.validation] = env.profile.registries;
  } else {
    s.usdc = await deploy('USDC (mock)', 'MockUSDC3009.sol', 'MockUSDC3009', []);
    s.identity = (await deploy('identity registry (mock)', 'MockRegistries.sol', 'MockIdentityRegistry', [])).address;
    s.reputation = (await deploy('reputation registry (mock)', 'MockRegistries.sol', 'MockReputationRegistry', [])).address;
    s.validation = (await deploy('validation registry (mock)', 'MockRegistries.sol', 'MockValidationRegistry', [])).address;
  }
  s.kernel = await deploy('SquareJob', 'SquareJob.sol', 'SquareJob',
    [s.usdc.address, funder.address, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, HOOK_GAS_LIMIT, funder.address]);
  s.keeper = await deploy('KeeperEvaluator', 'KeeperEvaluator.sol', 'KeeperEvaluator',
    [s.kernel.address, funder.address, CHALLENGE_WINDOW, DISPUTE_WINDOW, FINALIZE_GRACE]);
  s.registry = await deploy('PolicyRegistry', 'PolicyRegistry.sol', 'PolicyRegistry', [funder.address]);
  // The market's constructor gained the registry in #30. Read the arity off the
  // artifact rather than assume which side of that change this tree is on.
  const marketInputs = artifact('ClaimMarket.sol', 'ClaimMarket').abi.find((e) => e.type === 'constructor').inputs;
  s.market = await deploy('ClaimMarket', 'ClaimMarket.sol', 'ClaimMarket', marketInputs.length === 3
    ? [s.kernel.address, s.keeper.address, s.registry.address]
    : [s.kernel.address, s.keeper.address]);
  s.hook = await deploy('SquareHook', 'SquareHook.sol', 'SquareHook', [
    s.kernel.address, s.market.address, s.identity, s.reputation, s.validation,
    funder.address, s.keeper.address, MIN_REPUTATION_BUDGET,
  ]);
  await send(funder, s.kernel, 'setHookWhitelist', [s.hook.address, true]);
  return s;
}

async function installModule(s) {
  const { funder } = env.profile;
  compileVerifierForThisBuild();
  s.verifier = await deploy('verifier for this build', 'VerifierForThisBuild.sol', 'VerifierForThisBuild', []);
  s.module = await deploy('ComplianceModule', 'ComplianceModule.sol', 'ComplianceModule',
    [s.verifier.address, s.registry.address, s.kernel.address, funder.address, TOLERANCE_SECONDS]);
  await send(funder, s.module, 'setHook', [s.hook.address]);
  await send(funder, s.registry, 'setSpender', [s.module.address, true]);
  await send(funder, s.hook, 'setComplianceModule', [s.module.address]);
}

// ----------------------------------------------------------------- the actors

// What an actor needs for gas, in the chain's USDC when gas is USDC. Doubled,
// because the price moves between here and the last transaction.
async function gasAllowance(gasUnits) {
  const price = await env.publicClient.getGasPrice();
  return nativeToUsdcUnits(gasUnits * price * 2n);
}

async function fund(s, account, tokenUnits, gasUnits) {
  const { funder } = env.profile;
  if (env.profile.gasIsUsdc) {
    await send(funder, s.usdc, 'transfer', [account.address, tokenUnits + await gasAllowance(gasUnits)], 'fund an actor');
  } else {
    await mined(await wallet(funder).sendTransaction({ to: account.address, value: 10n ** 18n }), 'fund an actor (gas)');
    await send(funder, s.usdc, 'mint', [account.address, tokenUnits], 'fund an actor (USDC)');
  }
}

// ------------------------------------------------------------------ the policy

function policyFor(client, overrides = {}) {
  return {
    policy_id: crypto.randomUUID(),
    policy_salt: randomPolicySalt(),
    operator_id: client.address,
    max_daily_spend: String(USDC(0.1)),
    max_per_transaction: String(USDC(0.05)),
    allowed_endpoint_categories: ['api-call'],
    // An address nobody holds, drawn per run, so the list is not empty and the
    // blocked-recipient rule is live without blocking anyone the run pays.
    blocked_addresses: [privateKeyToAccount(generatePrivateKey()).address],
    ...overrides,
  };
}

// The commitment covers the policy half of a request only. The payment half is
// filled from the chain because buildCircuitInput needs one; none of it enters
// the hash.
async function commitmentOf(s, policy, provider) {
  return policyDataHash(await buildCircuitInput({
    ...policy,
    token_whitelist: [s.usdc.address],
    payment_recipient: provider.address,
    payment_token: s.usdc.address,
    payment_amount: '1',
    daily_spent_before: '0',
    payment_endpoint_category: 'api-call',
    current_unix_timestamp: String(await chainNow()),
  }));
}

const bytes32 = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

async function commit(s, client, policy, provider) {
  const commitment = await commitmentOf(s, policy, provider);
  await send(client, s.registry, 'setPolicy', [bytes32(commitment), BigInt(policy.max_daily_spend)]);
  return commitment;
}

// ISquareJob.JobStatus.Submitted. Jobs this run submitted are recorded, so a
// failure can settle the ones it left open instead of stranding their budgets
// in escrow under keys that exist only in this process.
const SUBMITTED = 2;
const submittedJobs = [];

async function submittedJob(s, client, provider, budget, label) {
  const expiry = (await chainNow()) + 86_400n;
  const created = await send(client, s.kernel, 'createJob',
    [provider.address, s.keeper.address, expiry, `square#28 ${label}`, s.hook.address], `createJob ${label}`);
  const [event] = parseEventLogs({ abi: s.kernel.abi, logs: created.logs, eventName: 'JobCreated' });
  const jobId = event.args.jobId;
  await send(provider, s.kernel, 'setBudget', [jobId, budget, '0x'], `setBudget ${label}`);
  await send(client, s.kernel, 'fund', [jobId, budget, '0x'], `fund ${label}`);
  await send(provider, s.kernel, 'submit', [jobId, keccak256(stringToHex(`square#28 ${label} deliverable`)), '0x'],
    `submit ${label}`);
  submittedJobs.push(jobId);
  return jobId;
}

// A request built from the chain, field by field: the amount is the job's net
// payout, the counter is what the registry says, the timestamp is the chain's
// own unless the scenario is about claiming another one.
async function proofFor(s, { policy, client, provider, jobId, timestamp }) {
  const result = await generateProof({
    ...policy,
    token_whitelist: [s.usdc.address],
    payment_recipient: provider.address,
    payment_token: s.usdc.address,
    payment_amount: String(await read(s.kernel, 'netPayout', [jobId])),
    daily_spent_before: String(await read(s.registry, 'spentToday', [client.address])),
    payment_endpoint_category: 'api-call',
    current_unix_timestamp: String(timestamp ?? await chainNow()),
  });
  const { a, b, c, input } = result.solidity;
  const big = (v) => BigInt(v);
  const encoded = encodeAbiParameters(PROOF_ABI, [
    a.map(big), b.map((row) => row.map(big)), c.map(big), input.map(big),
  ]);
  return { result, encoded, parts: [a.map(big), b.map((row) => row.map(big)), c.map(big), input.map(big)] };
}

function preview(s, { jobId, client, provider, amount, encoded }) {
  return read(s.module, 'previewRelease', [jobId, provider.address, amount, s.usdc.address, client.address, encoded]);
}

// Finalizes as the funder, who cranks, and reports who was paid, what the
// counter did, and which of the module's events it emitted, with the reason.
async function finalize(s, { jobId, client, provider, encoded, label }) {
  const before = {
    provider: await read(s.kernel, 'withdrawable', [provider.address]),
    client: await read(s.kernel, 'withdrawable', [client.address]),
    spent: await read(s.registry, 'spentToday', [client.address]),
  };
  const receipt = await send(env.profile.funder, s.keeper, 'finalize', [jobId, encoded], `finalize ${label}`);
  const moduleEvents = s.module
    ? parseEventLogs({ abi: s.module.abi, logs: receipt.logs })
      .filter((e) => e.address.toLowerCase() === s.module.address.toLowerCase() && e.args.jobId === jobId)
    : [];
  const refused = moduleEvents.find((e) => e.eventName === 'ReleaseRefused');
  return {
    hash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    price: receipt.effectiveGasPrice,
    providerPaid: (await read(s.kernel, 'withdrawable', [provider.address])) - before.provider,
    clientPaid: (await read(s.kernel, 'withdrawable', [client.address])) - before.client,
    spentMoved: (await read(s.registry, 'spentToday', [client.address])) - before.spent,
    verified: moduleEvents.some((e) => e.eventName === 'ReleaseVerified'),
    reason: refused ? hexToString(refused.args.reason, { size: 32 }).replace(/\0+$/, '') : null,
  };
}

function refusedFor(s, run, jobIdNet, reason) {
  check(`refused, by name: "${reason}"`, run.reason, reason);
  check('the provider is paid nothing', run.providerPaid, 0n);
  check('the client gets the whole net back', run.clientPaid, jobIdNet);
  check('and the day is not charged for it', run.spentMoved, 0n);
}

// The registry's counter resets at UTC midnight. Scenario 2 is the one that
// needs two releases on the same day, so it does not start within `seconds`
// of midnight; it waits for the new day instead of failing for the clock's
// sake.
async function sameDayAhead(seconds) {
  for (;;) {
    const now = Number(await chainNow());
    const left = 86_400 - (now % 86_400);
    if (left > seconds) return;
    process.stdout.write(`waiting ${left + 5}s for UTC midnight to pass, so scenario 2's releases share a day\n`);
    await new Promise((resolve) => setTimeout(resolve, (left + 5) * 1000));
  }
}

async function waitForWindows(s, jobIds) {
  let end = 0n;
  for (const jobId of jobIds) {
    const at = BigInt(await read(s.keeper, 'challengeEndsAt', [jobId]));
    if (at > end) end = at;
  }
  for (;;) {
    const now = await chainNow();
    if (now >= end) return;
    const gap = Number(end - now);
    process.stdout.write(`waiting ${gap}s for the last challenge window to close\n`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(gap, 15) * 1000 + 1000));
  }
}

// Whatever an actor holds goes back to the funder: its ledger balance on the
// kernel first, then its tokens, leaving what the sweep itself costs in gas on
// a chain where gas is USDC.
async function sweep(s, actors) {
  const { funder } = env.profile;
  let returned = 0n;
  for (const account of actors) {
    if ((await read(s.kernel, 'withdrawable', [account.address])) > 0n) {
      await send(account, s.kernel, 'withdraw', [], 'sweep: withdraw');
    }
    let balance = await read(s.usdc, 'balanceOf', [account.address]);
    if (balance === 0n) continue;
    if (env.profile.gasIsUsdc) {
      const gas = await env.publicClient.estimateContractGas({
        account, address: s.usdc.address, abi: s.usdc.abi, functionName: 'transfer', args: [funder.address, 1n],
      });
      balance -= await gasAllowance(gas);
    }
    if (balance > 0n) {
      await send(account, s.usdc, 'transfer', [funder.address, balance], 'sweep: return');
      returned += balance;
    }
  }
  process.stdout.write(`swept ${usdc(returned)} back to the funder from ${actors.length} actors\n`);
}

// After a failure: every job still Submitted is finalized with no proof, once
// its window has closed. With the module installed that is a refusal and the
// net goes to the client; before it, the provider is paid. Either way the money
// lands on an actor's ledger, where the sweep that follows collects it.
async function settleOpenJobs(s) {
  const open = [];
  for (const jobId of submittedJobs) {
    const record = await read(s.kernel, 'getJobRecord', [jobId]);
    if (Number(record.status) === SUBMITTED) open.push(jobId);
  }
  if (open.length === 0) return;
  await waitForWindows(s, open);
  let settled = 0;
  for (const jobId of open) {
    try {
      await send(env.profile.funder, s.keeper, 'finalize', [jobId, '0x'], `recover: finalize ${jobId}`);
      settled += 1;
    } catch (error) {
      process.stderr.write(`could not settle job ${jobId}: ${error.message}\n`);
    }
  }
  process.stdout.write(`settled ${settled} of ${open.length} job(s) the failure left open\n`);
}

// Set once the actors exist, so a run that fails halfway still returns what
// they hold. Their keys exist only in this process; without this, a failure on
// Arc would strand real USDC in addresses nobody can sign for again.
let recoverOnFailure;

// ----------------------------------------------------------------------- run

async function main() {
  env.profile = await chainProfile();
  env.chain = defineChain({
    id: env.profile.chainId,
    name: env.profile.name,
    nativeCurrency: env.profile.gasIsUsdc
      ? { name: 'USDC', symbol: 'USDC', decimals: 18 }
      : { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  env.publicClient = createPublicClient({ chain: env.chain, transport: http(RPC) });
  const { funder } = env.profile;
  const funderBefore = await env.publicClient.getBalance({ address: funder.address });
  process.stdout.write(`rpc      ${RPC}\nchain    ${env.profile.chainId} (${env.profile.name}, ${env.profile.client})\n`
    + `funder   ${funder.address}\nwindow   ${CHALLENGE_WINDOW}s challenge, tolerance ${TOLERANCE_SECONDS}s\n\n`);

  const s = await deployStack();
  process.stdout.write(`kernel   ${s.kernel.address}\nkeeper   ${s.keeper.address}\nhook     ${s.hook.address}\n`
    + `registry ${s.registry.address}\nusdc     ${s.usdc.address}\n\n`);

  const provider = privateKeyToAccount(generatePrivateKey());
  const clients = Object.fromEntries(['baseline', 's1', 's2', 's3', 's4', 's5', 's6']
    .map((name) => [name, privateKeyToAccount(generatePrivateKey())]));
  const budgets = {
    baseline: [USDC(0.02)], s1: [USDC(0.02)], s2: [USDC(0.02), USDC(0.02)], s3: [USDC(0.02)],
    s4: [USDC(0.02)], s5: [USDC(0.02)], s6: [USDC(0.03), USDC(0.02), USDC(0.03)],
  };
  const jobCount = Object.values(budgets).flat().length;
  recoverOnFailure = async () => {
    await settleOpenJobs(s);
    await sweep(s, [provider, ...Object.values(clients)]);
  };
  if (env.profile.gasIsUsdc) {
    // A run measured 26.2M gas on Arc, 12.6M of it deployments (29.4M on anvil,
    // which also deploys the mocks). Refuse before spending anything rather than
    // halfway through, at today's price and with the budgets on top; the actors'
    // own gas is inside that figure.
    const price = await env.publicClient.getGasPrice();
    const needed = nativeToUsdcUnits(30_000_000n * price) + Object.values(budgets).flat().reduce((a, b) => a + b, 0n);
    const have = await read(s.usdc, 'balanceOf', [funder.address]);
    if (have < needed) throw new Error(`the funder holds ${usdc(have)} and this run needs about ${usdc(needed)}`);
  }
  await fund(s, provider, 0n, BigInt(jobCount) * 300_000n);
  for (const [name, client] of Object.entries(clients)) {
    const total = budgets[name].reduce((a, b) => a + b, 0n);
    await fund(s, client, total, BigInt(budgets[name].length) * 500_000n + 300_000n);
    await send(client, s.usdc, 'approve', [s.kernel.address, total], `approve ${name}`);
  }

  // The policies. Each scenario has its own client, so each has its own
  // commitment and its own day's counter, and no scenario can pass or fail
  // because of another one's spending.
  const now = Number(await chainNow());
  const hourNow = Math.floor((now % 86_400) / 3_600);
  const claimedHour = (hourNow + 12) % 24;
  const policies = {
    s1: policyFor(clients.s1),
    s2: policyFor(clients.s2, { max_daily_spend: String(USDC(0.03)) }),
    s3: policyFor(clients.s3, { blocked_addresses: [provider.address] }),
    s4: policyFor(clients.s4),
    s5: policyFor(clients.s5, {
      time_restrictions: [{
        allowed_days: WEEK, allowed_hours_start: claimedHour, allowed_hours_end: claimedHour, timezone: 'UTC',
      }],
    }),
    s6: policyFor(clients.s6),
  };
  for (const [name, policy] of Object.entries(policies)) await commit(s, clients[name], policy, provider);

  const jobs = {};
  for (const [name, list] of Object.entries(budgets)) {
    jobs[name] = [];
    for (const [i, budget] of list.entries()) {
      jobs[name].push(await submittedJob(s, clients[name], provider, budget, `${name}${list.length > 1 ? String.fromCharCode(97 + i) : ''}`));
    }
  }
  await waitForWindows(s, Object.values(jobs).flat());
  const net = async (jobId) => read(s.kernel, 'netPayout', [jobId]);
  const results = [];

  // --------------------------------------------------------- 0, no module
  process.stdout.write('\n0  the hook with no module installed, for the baseline\n');
  const baseline = await finalize(s, { jobId: jobs.baseline[0], client: clients.baseline, provider, encoded: '0x', label: 'baseline' });
  check('the provider is paid the whole net', baseline.providerPaid, await net(jobs.baseline[0]));
  process.stdout.write(`        ${costLine(baseline.gasUsed, baseline.price)}  ${link(baseline.hash)}\n`);
  results.push(['0  released, no module', baseline]);

  await installModule(s);
  process.stdout.write(`\nverifier ${s.verifier.address} (this build's key)\nmodule   ${s.module.address}\n`);

  // ------------------------------------------------------------ 1, compliant
  process.stdout.write('\n1  a compliant payment\n');
  {
    const ctx = { policy: policies.s1, client: clients.s1, provider, jobId: jobs.s1[0] };
    const p = await proofFor(s, ctx);
    check('the circuit says it is compliant', p.result.public_signals.is_compliant, '1');
    const run = await finalize(s, { ...ctx, encoded: p.encoded, label: 's1' });
    check('the module verifies it', run.verified, true);
    check('the provider is paid the net', run.providerPaid, await net(ctx.jobId));
    check('the day is charged exactly that', run.spentMoved, await net(ctx.jobId));
    process.stdout.write(`        ${costLine(run.gasUsed, run.price)}  ${link(run.hash)}\n`);
    results.push(['1  released, proof verified', run]);
  }

  // ------------------------------------------------------- 2, the daily cap
  process.stdout.write('\n2  a payment that takes the day over its ceiling\n');
  await sameDayAhead(300);
  {
    const first = { policy: policies.s2, client: clients.s2, provider, jobId: jobs.s2[0] };
    const p1 = await proofFor(s, first);
    const released = await finalize(s, { ...first, encoded: p1.encoded, label: 's2a' });
    check('the first payment of the day is released', released.verified, true);
    const second = { ...first, jobId: jobs.s2[1] };
    const p2 = await proofFor(s, second);
    check('the circuit says the second is not compliant', p2.result.public_signals.is_compliant, '0');
    check('because of the daily limit, and only that', p2.result.violated_rules.join(), 'daily_limit');
    check('and the verifier still accepts the proof', await read(s.verifier, 'verifyProof', p2.parts), true);
    const run = await finalize(s, { ...second, encoded: p2.encoded, label: 's2b' });
    refusedFor(s, run, await net(second.jobId), 'is_compliant is 0');
    process.stdout.write(`        ${costLine(run.gasUsed, run.price)}  ${link(run.hash)}\n`);
    results.push(['2  refused, daily ceiling', run]);
  }

  // --------------------------------------------------- 3, blocked recipient
  process.stdout.write('\n3  a payment to a recipient the policy blocks\n');
  {
    const ctx = { policy: policies.s3, client: clients.s3, provider, jobId: jobs.s3[0] };
    const p = await proofFor(s, ctx);
    check('the circuit says it is not compliant', p.result.public_signals.is_compliant, '0');
    check('because the recipient is blocked, and only that', p.result.violated_rules.join(), 'blocked_recipient');
    const run = await finalize(s, { ...ctx, encoded: p.encoded, label: 's3' });
    refusedFor(s, run, await net(ctx.jobId), 'is_compliant is 0');
    process.stdout.write(`        ${costLine(run.gasUsed, run.price)}  ${link(run.hash)}\n`);
    results.push(['3  refused, blocked recipient', run]);
  }

  // ---------------------------------------------------- 4, policy replaced
  process.stdout.write('\n4  a proof built against a policy that has since been replaced\n');
  {
    const ctx = { policy: policies.s4, client: clients.s4, provider, jobId: jobs.s4[0] };
    const p = await proofFor(s, ctx);
    const amount = await net(ctx.jobId);
    check('the circuit says it is compliant', p.result.public_signals.is_compliant, '1');
    check('before the change the gate would release it', await preview(s, { ...ctx, amount, encoded: p.encoded }), true);
    const epochBefore = await read(s.registry, 'epochOf', [clients.s4.address]);
    await commit(s, clients.s4, { ...policies.s4, policy_salt: randomPolicySalt() }, provider);
    check('the client replaced its policy', await read(s.registry, 'epochOf', [clients.s4.address]), epochBefore + 1n);
    check('after it, the gate would not', await preview(s, { ...ctx, amount, encoded: p.encoded }), false);
    const run = await finalize(s, { ...ctx, encoded: p.encoded, label: 's4' });
    refusedFor(s, run, amount, 'policy commitment');
    process.stdout.write(`        ${costLine(run.gasUsed, run.price)}  ${link(run.hash)}\n`);
    results.push(['4  refused, commitment replaced', run]);
  }

  // --------------------------------------------------- 5, outside the window
  process.stdout.write(`\n5  a policy that allows ${String(claimedHour).padStart(2, '0')}:00-${String(claimedHour).padStart(2, '0')}:59 UTC, `
    + `paid at ${String(hourNow).padStart(2, '0')}:xx UTC\n`);
  {
    const ctx = { policy: policies.s5, client: clients.s5, provider, jobId: jobs.s5[0] };
    const honest = await proofFor(s, ctx);
    check('an honest proof, at the chain\'s time, is not compliant', honest.result.public_signals.is_compliant, '0');
    check('because of the time window, and only that', honest.result.violated_rules.join(), 'time_window');
    const today = BigInt(now - (now % 86_400));
    const claimed = today + BigInt(claimedHour) * 3_600n + 1_800n;
    const p = await proofFor(s, { ...ctx, timestamp: claimed });
    check('a proof claiming an allowed hour is compliant', p.result.public_signals.is_compliant, '1');
    const run = await finalize(s, { ...ctx, encoded: p.encoded, label: 's5' });
    refusedFor(s, run, await net(ctx.jobId), 'timestamp outside window');
    process.stdout.write(`        ${costLine(run.gasUsed, run.price)}  ${link(run.hash)}\n`);
    results.push(['5  refused, timestamp outside window', run]);
  }

  // ------------------------------------------------- 6, another job's proof
  process.stdout.write('\n6  a valid proof, presented against a job it was not built for\n');
  {
    const [x, y, z] = jobs.s6;
    const base = { policy: policies.s6, client: clients.s6, provider };
    const p = await proofFor(s, { ...base, jobId: x });
    const amountX = await net(x);
    const amountY = await net(y);
    check('the proof is valid for its own job', await preview(s, { ...base, jobId: x, amount: amountX, encoded: p.encoded }), true);
    const other = await finalize(s, { ...base, jobId: y, encoded: p.encoded, label: 's6 y' });
    refusedFor(s, other, amountY, 'amount');
    process.stdout.write(`        ${costLine(other.gasUsed, other.price)}  ${link(other.hash)}\n`);
    const own = await finalize(s, { ...base, jobId: x, encoded: p.encoded, label: 's6 x' });
    check('the same proof then releases its own job', own.verified, true);
    check('paying the provider that job\'s net', own.providerPaid, amountX);
    process.stdout.write(`        ${costLine(own.gasUsed, own.price)}  ${link(own.hash)}\n`);
    check('a job identical to its own has the same amount', await net(z), amountX);
    const again = await finalize(s, { ...base, jobId: z, encoded: p.encoded, label: 's6 z' });
    refusedFor(s, again, amountX, 'proof already used');
    process.stdout.write(`        ${costLine(again.gasUsed, again.price)}  ${link(again.hash)}\n`);
    results.push(['6  refused, another job (amount)', other], ['6  refused, identical job (spent)', again]);
  }

  // ------------------------------------------------------------ the costs
  process.stdout.write('\nfinalize, end to end\n');
  for (const [label, run] of results) {
    const delta = run === baseline ? '' : `   +${run.gasUsed - baseline.gasUsed} over the baseline`;
    process.stdout.write(`  ${label.padEnd(38)} ${String(run.gasUsed).padStart(9)}${delta}`
      + `${env.profile.gasIsUsdc ? `   ${usdc(nativeToUsdcUnits(fee(run.gasUsed, run.price)))}` : ''}\n`);
  }

  recoverOnFailure = undefined;
  await sweep(s, [provider, ...Object.values(clients)]);
  const deployments = ledger.filter((entry) => entry.label.startsWith('deploy '));
  const deployGas = deployments.reduce((a, e) => a + e.gasUsed, 0n);
  const allGas = ledger.reduce((a, e) => a + e.gasUsed, 0n);
  process.stdout.write(`\n${ledger.length} transactions, ${allGas} gas; ${deployments.length} deployments, ${deployGas} gas\n`);
  if (env.profile.gasIsUsdc) {
    const funderAfter = await env.publicClient.getBalance({ address: funder.address });
    process.stdout.write(`the run cost the funder ${usdc(nativeToUsdcUnits(funderBefore - funderAfter))}, `
      + 'budgets included, after the sweep\n');
  }
  if (process.env.SCENARIO_REPORT) {
    fs.writeFileSync(process.env.SCENARIO_REPORT, `${JSON.stringify({
      chainId: env.profile.chainId, client: env.profile.client, funder: funder.address,
      contracts: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'string' ? v : v.address])),
      transactions: ledger.map((e) => ({ ...e, gasUsed: String(e.gasUsed), price: String(e.price) })),
      finalize: results.map(([label, run]) => ({ label, hash: run.hash, gasUsed: String(run.gasUsed), price: String(run.price), reason: run.reason })),
    }, null, 2)}\n`);
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nSix scenarios on chain ${env.profile.chainId} (${env.profile.client}): released when compliant, `
    + 'refused by name in every other case.\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
  if (recoverOnFailure) {
    try {
      await recoverOnFailure();
    } catch (recoveryError) {
      process.stderr.write(`recovering after the failure failed too: ${recoveryError.message}\n`);
    }
  }
} finally {
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
}
// snarkjs leaves a worker pool up after fullProve; without this the process
// finishes its work and never exits.
process.exit(process.exitCode ?? 0);
