#!/usr/bin/env node
// A non-compliant payment is refused, and a spent proof cannot pay twice —
// from the prover to the chain, on a local chain the script owns.
//
// square#76 was split out of #19 because neither half could be shown against
// the chain surface #19 had: the verifier is a stateless `view`, it verifies a
// proof carrying `is_compliant = 0` on purpose, and a view function has nowhere
// to record that a proof was spent. #27 built both mechanisms into
// ComplianceModule; this is the end-to-end evidence that they work when the
// proof comes from the real prover and the release goes through the real
// kernel, keeper and hook.
//
// Five jobs, in this order:
//
//   D  baseline     the hook with no module installed, so the gate's own cost
//                   can be measured as a difference rather than estimated
//   A  refused      a payment over the per-transaction ceiling: the circuit
//                   emits is_compliant = 0, the verifier still accepts the
//                   proof, and the release pays the provider nothing
//   B  released     a compliant payment: the provider is paid, the day's
//                   counter moves by exactly what was released
//   C  replayed     B's proof, byte for byte, against a second identical job
//   E  replayed     B's proof re-randomised — (rA, r⁻¹B + sδ, C + rsA), same
//                   eight signals, different bytes — which is the attack the
//                   review of #190 found and the reason the mark is keyed on
//                   the statement rather than the bytes
//
// Refusals are read off the module's own ReleaseRefused event, by reason, so a
// job refused for the wrong reason fails the run instead of passing it.
//
// Why a local chain and not Arc. Nothing here needs Arc's precompiles — #19
// already shows the verifier running against them — and everything here needs
// things a shared testnet cannot give a CI run: a hook whose owner key is on
// the runner, a clock that can be moved past a one-day challenge window, and
// accounts that can sign without secrets. The chain-id check below refuses to
// run anywhere else.
//
// Why a second verifier and module. CI builds its own development proving key
// with random phase-2 entropy, so a verifier generated from the committed key
// rejects every proof this run produces — only delta moves between builds, and
// a stale delta fails silently at the pairing. So the script compiles the
// repository's verifier with this build's constants, exactly as #19 does, then
// deploys a ComplianceModule bound to it and installs that in the hook.
// DeployLocal is left alone, and so are the deterministic addresses the SDK's
// local deployment map relies on.
//
//   anvil &                                              # 31337
//   forge script script/DeployLocal.s.sol --rpc-url … --broadcast
//   node script/refuse-and-replay-on-anvil.mjs
//
// Needs the circuit artifacts: PROVER_ARTIFACTS_DIR, or services/prover/artifacts
// holding payment.wasm, payment.zkey and payment_vk.json.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');

const RPC = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const ANVIL_CHAIN_ID = 31337;
const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.join(REPO, 'services', 'prover', 'artifacts');
const VK = path.join(ARTIFACTS, 'payment_vk.json');

// anvil's default accounts, unlocked, so nothing here holds a key. Their roles
// are the ones DeployLocal.s.sol gives them.
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // owner of the hook and registry
const CLIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';   // ANVIL_1, funded with USDC
const PROVIDER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // ANVIL_2, agent 1
const CRANKER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';  // ANVIL_3; finalize is permissionless

const FULL_BPS = 10_000;
const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const TOLERANCE_SECONDS = 3600;
const PROOF_TYPE = 'f(uint256[2],uint256[2][2],uint256[2],uint256[8])';

const { buildCircuitInput, generateProof } = await import(
  path.join(REPO, 'services', 'prover', 'src', 'prover.js')
);
const { randomPolicySalt } = await import(
  path.join(REPO, 'services', 'prover', 'src', 'commitment.js')
);
const { policyDataHash } = await import(
  path.join(REPO, 'circuits', 'test', 'helpers', 'inputs.mjs')
);

// ------------------------------------------------------------------ plumbing

function cast(args) {
  return execFileSync('cast', args, { encoding: 'utf8', timeout: 120_000 }).trim();
}

function read(to, signature, ...args) {
  return cast(['call', to, signature, ...args.map(String), '--rpc-url', RPC]).split(' ')[0];
}

// Sends as an unlocked anvil account and returns the receipt. A reverted
// transaction is an error here: every step the script takes is supposed to
// succeed, and the refusals it demonstrates are refusals *inside* a successful
// release, not reverts.
function send(from, to, signature, ...args) {
  const receipt = JSON.parse(cast([
    'send', to, signature, ...args.map(String),
    '--from', from, '--unlocked', '--rpc-url', RPC, '--json',
  ]));
  if (receipt.status !== '0x1') throw new Error(`${signature} reverted: ${receipt.transactionHash}`);
  return receipt;
}

function deploy(target, ...constructorArgs) {
  const args = ['create', target, '--rpc-url', RPC, '--unlocked', '--from', DEPLOYER, '--broadcast', '--json'];
  if (constructorArgs.length > 0) args.push('--constructor-args', ...constructorArgs.map(String));
  const out = execFileSync('forge', args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  // forge prints the JSON pretty, over several lines, and may print compiler
  // chatter before it, so the object is whatever lies between the outer braces.
  const deployed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).deployedTo;
  if (!deployed) throw new Error(`forge create ${target} returned no address`);
  return deployed;
}

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

const latestTimestamp = async () => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
const bytes32 = (decimal) => `0x${BigInt(decimal).toString(16).padStart(64, '0')}`;
const usdc = (units) => `${(Number(units) / 1e6).toFixed(6)} USDC`;

let failures = 0;
function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    process.stdout.write(`  FAIL  ${name}\n        expected ${expected}\n        got      ${actual}\n`);
    failures += 1;
  }
}

// ------------------------------------------------------- the verifier for this build

// The repository's verifier with this build's key constants, as #19 builds it —
// see contracts/script/prove-and-verify-on-arc.mjs for why a scratch Foundry
// project is not used. Kept on disk until the end of the run, because the
// re-randomiser reads delta out of it: delta is the one point that differs
// between builds, and reading it from anywhere else is how a re-randomised copy
// silently fails to verify.
const GENERATED_DIR = path.join(ROOT, 'src', 'generated');
const GENERATED = path.join(GENERATED_DIR, 'VerifierForThisBuild.sol');

function writeVerifierForThisBuild() {
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
      .replace('contract Groth16Verifier {', 'contract VerifierForThisBuild {')
      // The copy lands one directory deeper than the original, so its imports
      // have to climb one further. square#231 moved SCALAR_FIELD into
      // IGroth16Verifier.sol, where PolicyRegistry can read the same value, and
      // this line is what keeps the generated copy compiling.
      .replace(/from "\.\/interfaces\//g, 'from "../interfaces/'),
  );
}

// ------------------------------------------------------------------- the jobs

async function submittedJob(stack, budget) {
  send(CLIENT, stack.kernel, 'createJob(address,address,uint256,string,address)',
    PROVIDER, stack.keeper, (await latestTimestamp()) + 30 * 86_400, 'spec:square#76', stack.hook);
  const jobId = BigInt(read(stack.kernel, 'jobCounter()(uint256)'));
  send(PROVIDER, stack.kernel, 'setBudget(uint256,uint256,bytes)', jobId, budget, '0x');
  send(CLIENT, stack.kernel, 'fund(uint256,uint256,bytes)', jobId, budget, '0x');
  send(PROVIDER, stack.kernel, 'submit(uint256,bytes32,bytes)', jobId, bytes32(jobId), '0x');
  return jobId;
}

// The request the prover gets is built from the chain, field by field: the
// amount is the job's net payout after fees, the counter is what the registry
// says the client has spent today, the timestamp is the chain's own. Those are
// three of the eight things the module binds, so a request built any other way
// would be refused for the wrong reason.
async function proofFor(stack, policy, jobId) {
  const request = {
    ...policy,
    payment_recipient: PROVIDER,
    payment_token: stack.usdc,
    payment_amount: read(stack.kernel, 'netPayout(uint256)(uint256)', jobId),
    daily_spent_before: read(stack.registry, 'spentToday(address)(uint256)', CLIENT),
    payment_endpoint_category: 'api-call',
    current_unix_timestamp: String(await latestTimestamp()),
  };
  const result = await generateProof(request);
  const { a, b, c, input } = result.solidity;
  const encoded = cast([
    'abi-encode', PROOF_TYPE,
    `[${a.join(',')}]`, `[[${b[0].join(',')}],[${b[1].join(',')}]]`, `[${c.join(',')}]`, `[${input.join(',')}]`,
  ]);
  return { result, encoded, solidity: result.solidity };
}

const REFUSED = cast(['keccak', 'ReleaseRefused(uint256,bytes32)']);
const VERIFIED = cast(['keccak', 'ReleaseVerified(uint256,address,uint256,bytes32)']);

// Finalizes and reports what happened: who was paid, what the counter did, and
// which of the module's two events it emitted — with the refusal's reason.
function finalize(stack, jobId, encodedProof) {
  const provider = BigInt(read(stack.kernel, 'withdrawable(address)(uint256)', PROVIDER));
  const client = BigInt(read(stack.kernel, 'withdrawable(address)(uint256)', CLIENT));
  const spent = BigInt(read(stack.registry, 'spentToday(address)(uint256)', CLIENT));

  const receipt = send(CRANKER, stack.keeper, 'finalize(uint256,bytes)', jobId, encodedProof);

  const moduleLogs = receipt.logs.filter((l) => l.address.toLowerCase() === stack.module.toLowerCase()
    && BigInt(l.topics[1] ?? 0) === jobId);
  const refused = moduleLogs.find((l) => l.topics[0] === REFUSED);
  return {
    gas: BigInt(receipt.gasUsed),
    tx: receipt.transactionHash,
    providerPaid: BigInt(read(stack.kernel, 'withdrawable(address)(uint256)', PROVIDER)) - provider,
    clientPaid: BigInt(read(stack.kernel, 'withdrawable(address)(uint256)', CLIENT)) - client,
    spentMoved: BigInt(read(stack.registry, 'spentToday(address)(uint256)', CLIENT)) - spent,
    verified: moduleLogs.some((l) => l.topics[0] === VERIFIED),
    reason: refused ? cast(['parse-bytes32-string', refused.data]) : null,
  };
}

// ----------------------------------------------------------------------- run

async function main() {
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  if (chainId !== ANVIL_CHAIN_ID) {
    throw new Error(`${RPC} is chain ${chainId}. This script warps the clock and signs as unlocked `
      + 'accounts, and it will only do that on a local anvil (31337).');
  }
  await rpc('anvil_nodeInfo'); // throws on anything that is not anvil

  const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${ANVIL_CHAIN_ID}.json`), 'utf8'));
  const stack = {
    kernel: deployment.SquareJob,
    keeper: deployment.KeeperEvaluator,
    hook: deployment.SquareHook,
    registry: deployment.PolicyRegistry,
    usdc: deployment.USDC,
  };
  process.stdout.write(`rpc      ${RPC}\nchain id ${chainId}\nkernel   ${stack.kernel}\n\n`);

  // The policy. Its salt is drawn per run for the reason #130 settled: a salt
  // written into a script is a salt that has stopped hiding anything.
  const policy = {
    policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    policy_salt: randomPolicySalt(),
    operator_id: CLIENT,
    max_daily_spend: String(USDC(1000)),
    max_per_transaction: String(USDC(50)),
    allowed_endpoint_categories: ['api-call'],
    blocked_addresses: ['0x2222222222222222222222222222222222222222'],
    token_whitelist: [stack.usdc],
  };
  const commitment = await policyDataHash(await buildCircuitInput({
    ...policy, payment_recipient: PROVIDER, payment_token: stack.usdc, payment_amount: '1',
    daily_spent_before: '0', payment_endpoint_category: 'api-call', current_unix_timestamp: '1',
  }));

  send(CLIENT, stack.usdc, 'approve(address,uint256)', stack.kernel, USDC(1_000_000));
  send(CLIENT, stack.registry, 'setPolicy(bytes32,uint128)', bytes32(commitment), USDC(1000));

  // All five jobs are submitted first and the clock moved once, so every release
  // lands on the same UTC day. The registry's counter resets lazily at midnight,
  // and B and C have to see the same day for C to be a replay and not a new day.
  const jobs = {
    D: await submittedJob(stack, USDC(20)),
    A: await submittedJob(stack, USDC(100)),
    B: await submittedJob(stack, USDC(20)),
    C: await submittedJob(stack, USDC(20)),
    E: await submittedJob(stack, USDC(20)),
  };
  await rpc('evm_increaseTime', [86_400 + 60]);
  await rpc('evm_mine');

  // ------------------------------------------------------------ D, ungated
  process.stdout.write('D  the hook with no module, for the baseline\n');
  const baseline = finalize({ ...stack, module: '0x0000000000000000000000000000000000000000' }, jobs.D, '0x');
  check('the provider is paid the whole net', baseline.providerPaid, read(stack.kernel, 'netPayout(uint256)(uint256)', jobs.D));
  process.stdout.write(`        gas ${baseline.gas}\n\n`);

  // ------------------------------------------- install a module for this build
  writeVerifierForThisBuild();
  try {
    const verifier = deploy('src/generated/VerifierForThisBuild.sol:VerifierForThisBuild');
    stack.module = deploy('src/ComplianceModule.sol:ComplianceModule',
      verifier, stack.registry, stack.kernel, DEPLOYER, TOLERANCE_SECONDS);
    send(DEPLOYER, stack.module, 'setHook(address)', stack.hook);
    send(DEPLOYER, stack.registry, 'setSpender(address,bool)', stack.module, true);
    send(DEPLOYER, stack.hook, 'setComplianceModule(address)', stack.module);
    process.stdout.write(`verifier ${verifier} (this build's key)\nmodule   ${stack.module}\n\n`);

    // ---------------------------------------------------------- A, refused
    process.stdout.write('A  over the per-transaction ceiling\n');
    const a = await proofFor(stack, policy, jobs.A);
    check('the circuit says it is not compliant', a.result.public_signals.is_compliant, '0');
    check('the per-transaction rule is the one that failed',
      a.result.violated_rules.includes('per_transaction_limit'), true);
    const { a: pa, b: pb, c: pc, input: pi } = a.solidity;
    check('and the verifier still accepts the proof', read(verifier,
      'verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])(bool)',
      `[${pa.join(',')}]`, `[[${pb[0].join(',')}],[${pb[1].join(',')}]]`, `[${pc.join(',')}]`, `[${pi.join(',')}]`), 'true');
    const refused = finalize(stack, jobs.A, a.encoded);
    check('the module refuses it, by name', refused.reason, 'is_compliant is 0');
    check('the provider is paid nothing', refused.providerPaid, 0n);
    check('the client gets the whole net back', refused.clientPaid, read(stack.kernel, 'netPayout(uint256)(uint256)', jobs.A));
    check('and the day is not charged for it', refused.spentMoved, 0n);
    process.stdout.write(`        gas ${refused.gas}\n\n`);

    // --------------------------------------------------------- B, released
    process.stdout.write('B  a compliant payment\n');
    const b = await proofFor(stack, policy, jobs.B);
    check('the circuit says it is compliant', b.result.public_signals.is_compliant, '1');
    const released = finalize(stack, jobs.B, b.encoded);
    const netB = BigInt(read(stack.kernel, 'netPayout(uint256)(uint256)', jobs.B));
    check('the module verifies it', released.verified, true);
    check('the provider is paid the net', released.providerPaid, netB);
    check('the day is charged exactly that', released.spentMoved, netB);
    process.stdout.write(`        gas ${released.gas}\n\n`);

    // ------------------------------------------------ C, the same bytes again
    process.stdout.write('C  B\'s proof, byte for byte, on an identical job\n');
    const replay = finalize(stack, jobs.C, b.encoded);
    check('the module refuses it, by name', replay.reason, 'proof already used');
    check('the provider is not paid twice', replay.providerPaid, 0n);
    check('the day is not charged twice', replay.spentMoved, 0n);
    process.stdout.write(`        gas ${replay.gas}\n\n`);

    // ----------------------------------------- E, the same statement, new bytes
    process.stdout.write('E  B\'s proof re-randomised: same eight signals, different bytes\n');
    const scratch = path.join(ROOT, 'src', 'generated', 'spent.json');
    fs.writeFileSync(scratch, JSON.stringify({ spent: b.solidity }));
    const copy = JSON.parse(execFileSync(process.execPath, [
      path.join(REPO, 'circuits', 'scripts', 'rerandomise.mjs'), scratch, VK, 'spent', GENERATED,
    ], { encoding: 'utf8', timeout: 60_000 }));
    const hex = (d) => `0x${BigInt(d).toString(16).padStart(64, '0')}`;
    const copied = {
      a: copy.a.map(hex), b: copy.b.map((row) => row.map(hex)), c: copy.c.map(hex), input: copy.input.map(hex),
    };
    check('the signals are the ones already spent', copied.input.join(), b.solidity.input.join());
    check('the bytes are not', copied.a.join() === b.solidity.a.join(), false);
    check('and this build\'s verifier accepts the copy', read(verifier,
      'verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])(bool)',
      `[${copied.a.join(',')}]`, `[[${copied.b[0].join(',')}],[${copied.b[1].join(',')}]]`,
      `[${copied.c.join(',')}]`, `[${copied.input.join(',')}]`), 'true');
    const encodedCopy = cast([
      'abi-encode', PROOF_TYPE, `[${copied.a.join(',')}]`,
      `[[${copied.b[0].join(',')}],[${copied.b[1].join(',')}]]`, `[${copied.c.join(',')}]`, `[${copied.input.join(',')}]`,
    ]);
    const rerandomised = finalize(stack, jobs.E, encodedCopy);
    check('the module refuses it, by name', rerandomised.reason, 'proof already used');
    check('the provider is not paid for it', rerandomised.providerPaid, 0n);
    process.stdout.write(`        gas ${rerandomised.gas}\n\n`);

    // ------------------------------------------------------------ the costs
    process.stdout.write('gas, finalize end to end\n');
    for (const [label, run] of [
      ['D  no module (baseline)', baseline], ['A  refused, not compliant', refused],
      ['B  released', released], ['C  refused, same bytes', replay], ['E  refused, re-randomised', rerandomised],
    ]) {
      const delta = run === baseline ? '' : `   +${run.gas - baseline.gas} over the baseline`;
      process.stdout.write(`  ${label.padEnd(28)} ${String(run.gas).padStart(9)}${delta}\n`);
    }
    process.stdout.write(`\nnet released in B: ${usdc(netB)}\n`);
  } finally {
    fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write('\nRefused when not compliant, released when compliant, and a spent proof paid once — '
    + 'as the same bytes and as a re-randomised copy.\n');
}

try {
  await main();
} catch (error) {
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}
// snarkjs leaves a worker pool up after fullProve; without this the process
// finishes its work and never exits, which is how #19's CI job once sat at its
// ceiling having already printed a result.
process.exit(0);
