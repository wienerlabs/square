#!/usr/bin/env node
// A policy, a proof built from it, and the chain accepting that proof.
//
// square#19 asks for the three steps end to end: define a policy and produce its
// Poseidon commitment, get a proof from the prover, and watch Arc verify it.
// script/verify-on-arc.mjs already does the last step, but from
// test/fixtures/proofs.json — proofs generated at some earlier time. That
// answers "does a proof verify on Arc". It does not answer "does a proof built
// from this policy, right now, carry this policy's commitment into a
// verification the chain accepts", which is the claim phase 2 is finished on.
//
// So this script starts from the policy and never reads a fixture.
//
// The commitment is computed twice by two different pieces of code that must
// agree, which is the whole point:
//
//   policy → buildCircuitInput → policyDataHash()   an ordinary Poseidon in JS
//   policy → buildCircuitInput → the circuit        Poseidon as constraints
//
// The second is public signal 1 of the proof. `policyDataHash` is the same
// implementation circuits/test/payment.test.js uses to hold the circuit honest,
// imported rather than copied so the two cannot drift apart.
//
// Then the chain: a proof whose eight public signals are covered by the pairing,
// so a substituted commitment is not a different answer, it is a proof that does
// not verify. The negative control at the end shows exactly that, because a
// check that has only ever passed has not been tested.
//
//   node script/prove-and-verify-on-arc.mjs                 state override, nothing deployed
//   node script/prove-and-verify-on-arc.mjs --address 0x…   a deployed verifier
//
// Needs the circuit artifacts. PROVER_ARTIFACTS_DIR points at a directory
// holding payment.wasm and payment.zkey — see circuits/README.md.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io';

// verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])
const SELECTOR = '0xc9219a7a';
const SCRATCH = '0x00000000000000000000000000000000000c0de0';
const ARC_TESTNET_CHAIN_ID = 5042002;
const TRUE = `0x${'0'.repeat(63)}1`;
const FALSE = `0x${'0'.repeat(64)}`;

const { buildCircuitInput, generateProof } = await import(
  path.join(REPO, 'services', 'prover', 'src', 'prover.js')
);
const { policyDataHash } = await import(
  path.join(REPO, 'circuits', 'test', 'helpers', 'inputs.mjs')
);
const { randomPolicySalt } = await import(
  path.join(REPO, 'services', 'prover', 'src', 'commitment.js')
);

// One policy, written out rather than imported, so what is being proved is
// visible in the file that proves it.
//
// With one exception: policy_salt is generated per run, below, and is not
// written here. square#98 made the commitment a tree of salted leaves so that
// a field cannot be recovered from the root by trying values against it, and a
// salt committed to a public repository is a salt that no longer does that. An
// operator keeps one salt with the policy and reuses it, which is what makes
// the commitment stable across proofs; this script is a demonstration and has
// no policy to keep, so it draws a fresh one and prints it. The run below shows
// what that buys: the same policy under a different salt commits to a different
// root.
const USDC = '0x3600000000000000000000000000000000000000';
const POLICY = {
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: ['0x2222222222222222222222222222222222222222'],
  token_whitelist: [USDC],
  time_restrictions: [{
    timezone: 'UTC',
    allowed_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    allowed_hours_start: 9,
    allowed_hours_end: 18,
  }],
};

// A payment that satisfies all six rules. 2026-09-02T13:45:30Z is a Wednesday
// at 13:45 UTC, inside the window above.
const PAYMENT = {
  payment_recipient: '0x1111111111111111111111111111111111111111',
  payment_token: USDC,
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
};

// Every call is bounded. A CI job that hangs on an unresponsive RPC burns the
// whole run and reports nothing; a call that times out says which one and why.
const RPC_TIMEOUT_MS = Number(process.env.ARC_RPC_TIMEOUT_MS ?? 30_000);

async function rpc(method, params) {
  let response;
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${method}: ${RPC} did not answer within ${RPC_TIMEOUT_MS} ms (${error.name})`);
  }
  if (!response.ok) throw new Error(`${method}: ${RPC} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// The committed verifier's own source, re-parameterised with the key that was
// actually built, compiled in a scratch project so nothing is written into the
// repository.
//
// This is necessary rather than fussy. `circuits/scripts/build.mjs` takes its
// phase-2 entropy from crypto.getRandomValues, so every build produces a
// different `delta` and therefore a verifier that matches only that build.
// alpha, beta, gamma and the IC points come from the powers of tau and the
// circuit, so they are identical across builds — which is why a stale key looks
// almost right and fails only at the pairing. Verified on this repository: a
// locally built key's IC0_X matched the committed verifier exactly while
// DELTA_X_RE did not.
//
// So a freshly built key can never verify against the committed or deployed
// contract while the development key is random, and pinning this script to
// either would test the frozen artifact rather than the pipeline. What is
// exercised here is the repository's verifier bytecode, on Arc, against Arc's
// own precompiles — parameterised by the key this run built. See
// docs/deploy/end-to-end-5042002.md.
function verifierBytecodeFor(verificationKey) {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'Groth16Verifier.sol'), 'utf8');
  const constants = execFileSync(
    process.execPath,
    [path.join(ROOT, 'script', 'verifier-constants.mjs'), verificationKey],
    { encoding: 'utf8', timeout: 60_000 },
  ).trimEnd();

  const first = source.indexOf('    uint256 private constant ALPHA_X');
  const lastIc = source.lastIndexOf('    uint256 private constant IC');
  if (first < 0 || lastIc < 0) {
    throw new Error('could not find the key constants in src/Groth16Verifier.sol');
  }
  const end = source.indexOf('\n', lastIc) + 1;
  const rebuilt = (source.slice(0, first) + constants + '\n' + source.slice(end))
    // A distinct name so it cannot collide with the real contract in any
    // `forge` command that resolves by name rather than by path.
    .replace('contract Groth16Verifier {', 'contract VerifierForThisBuild {');

  // Compiled inside this Foundry project, not a scratch one.
  //
  // A scratch project has its own out/ and cache/, so `forge` resolves the
  // compiler from nothing and, on a cold CI runner, sits waiting on a download
  // that the job's warm-up step already did for *this* project. That is what
  // hung the end-to-end job for hours before it was cancelled. Compiling here
  // reuses the warm cache and the repository's own solc pin.
  //
  // The file is generated, gitignored and removed in the finally below; it
  // exists only for the length of one `forge inspect`.
  const dir = path.join(ROOT, 'src', 'generated');
  const file = path.join(dir, 'VerifierForThisBuild.sol');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, rebuilt);
  try {
    return execFileSync(
      'forge',
      ['inspect', 'src/generated/VerifierForThisBuild.sol:VerifierForThisBuild',
        'deployedBytecode'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300_000 },
    ).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function calldataFor(solidity, mutate = (words) => words) {
  const words = mutate([
    ...solidity.a, ...solidity.b[0], ...solidity.b[1], ...solidity.c, ...solidity.input,
  ]);
  return SELECTOR + words.map((w) => w.slice(2)).join('');
}

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    process.stdout.write(`  FAIL  ${name}\n        expected ${expected}\n        got      ${actual}\n`);
    failures += 1;
  }
}

const timings = [];
async function stage(name, fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  timings.push([name, ms]);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--address');
  const deployed = flag >= 0 ? argv[flag + 1] : null;

  const artifacts = process.env.PROVER_ARTIFACTS_DIR
    ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
    : path.join(REPO, 'services', 'prover', 'artifacts');
  for (const file of ['payment.wasm', 'payment.zkey']) {
    if (!fs.existsSync(path.join(artifacts, file))) {
      throw new Error(
        `${path.join(artifacts, file)} is missing. Build the circuit first:\n`
        + '  cd circuits && npm ci && npm run build\n'
        + '  cp build/payment.zkey build/payment_js/payment.wasm ../services/prover/artifacts/',
      );
    }
  }

  // The verifying key of the key this run will prove with.
  const vkPath = path.join(artifacts, 'payment_vk.json');
  if (!fs.existsSync(vkPath)) {
    // circuits' own snarkjs, not npx: npx resolves over the network and can sit
    // waiting on a prompt that a non-interactive run never answers.
    const snarkjs = path.join(REPO, 'circuits', 'node_modules', '.bin', 'snarkjs');
    if (!fs.existsSync(snarkjs)) {
      throw new Error(`${vkPath} is missing and ${snarkjs} is not installed; run npm ci in circuits/`);
    }
    execFileSync(
      snarkjs,
      ['zkey', 'export', 'verificationkey', path.join(artifacts, 'payment.zkey'), vkPath],
      { stdio: 'ignore' },
    );
  }

  // Which chain answered, checked rather than printed.
  //
  // This script's only claim is "Arc accepted it", and ARC_RPC_URL can point
  // anywhere, so the endpoint has to be established before the claim means
  // anything. square#127 raised the same gap in verify-on-arc.mjs.
  //
  // The chain id alone does not establish it, and that is the part worth being
  // careful about. This repository runs anvil forks of Arc with
  // `--chain-id 5042002` — packages/aa/scripts/fork.ts:119 and
  // contracts/README.md:72 — so a fork answers the id identically. Measured
  // against both, side by side:
  //
  //                        Arc            anvil --fork-url Arc
  //   eth_chainId          5042002        5042002          identical
  //   web3_clientVersion   arc/v1         anvil/v1.5.1     differs
  //   anvil_nodeInfo       unsupported    returns state    differs
  //
  // So the id is necessary and not sufficient, and what separates the two is
  // whether the node has a development namespace. A fork is exactly what this
  // script must not accept: it runs revm, and the whole point here is that
  // Arc's own 0x06/0x07/0x08 agree with revm's rather than assuming it.
  //
  // What this does not do is prove the endpoint is Arc. A hostile RPC can lie
  // about all three. It catches the realistic failure — an ARC_RPC_URL left
  // pointing at somebody's local fork — and the final line names what answered
  // so the reader is not taking that on trust either.
  const chainId = Number(await rpc('eth_chainId', []));
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `${RPC} is chain ${chainId}, not Arc Testnet (${ARC_TESTNET_CHAIN_ID}). `
      + 'Nothing below would be a statement about Arc.',
    );
  }

  const client = await rpc('web3_clientVersion', []).catch(() => 'unknown');
  const isSimulator = await rpc('anvil_nodeInfo', []).then(() => true, () => false);
  if (isSimulator) {
    throw new Error(
      `${RPC} answers anvil_nodeInfo, so it is a development node — very likely `
      + 'an anvil fork of Arc, which reports Arc\'s chain id and runs revm. This '
      + 'script exists to check Arc\'s own precompiles, which a fork does not '
      + 'have.',
    );
  }

  const block = Number(await rpc('eth_blockNumber', []));
  process.stdout.write(
    `rpc      ${RPC}\nchain id ${chainId}\nclient   ${client}\nblock    ${block}\n`,
  );
  process.stdout.write(deployed
    ? `verifier ${deployed} (deployed — must have been generated from this exact key)\n\n`
    : '\nverifier  the repository contract, keyed to this build, state-overridden at a\n'
      + '          scratch address on Arc. Nothing deployed, nothing committed.\n\n');

  // ---------------------------------------------------- 1. policy → commitment
  const policySalt = randomPolicySalt();
  const request = { ...POLICY, ...PAYMENT, policy_salt: policySalt };
  const commit = async (req) => policyDataHash(await buildCircuitInput(req));
  const expectedCommitment = await stage('commitment', () => commit(request));

  // The salt is doing work, and a run that printed one root would not show it.
  // Two more commitments, four milliseconds each now that the Poseidon tables
  // are built, and between them they pin both halves of what a salt is for:
  //
  //   another salt, same policy  ->  a different root, or the root is a lookup
  //                                  table for the eight guessable values in it
  //   same salt,    same policy  ->  the same root, or an operator could never
  //                                  prove twice against one commitment
  const underAnotherSalt = await stage('commitment under another salt',
    () => commit({ ...request, policy_salt: randomPolicySalt() }));
  const recommitted = await stage('commitment again, same salt', () => commit(request));

  process.stdout.write('a policy, committed off chain\n');
  process.stdout.write(`  policy_salt       ${policySalt}\n`);
  process.stdout.write(`  policy_data_hash  ${expectedCommitment}\n`);
  process.stdout.write(`  another salt      ${underAnotherSalt}\n`);
  check('a different salt moves the commitment',
    String(underAnotherSalt !== expectedCommitment), 'true');
  check('the same salt does not', recommitted, expectedCommitment);
  process.stdout.write('\n');

  // ------------------------------------------------------------- 2. the proof
  const result = await stage('prove', () => generateProof(request));
  process.stdout.write('a proof built from that policy, now\n');

  // -------------------------------------------- 3. the commitment is carried
  check('the circuit committed to the same policy',
    result.public_signals.policy_data_hash, expectedCommitment);
  check('is_compliant', result.public_signals.is_compliant, '1');
  check('recipient', BigInt(result.public_signals.recipient).toString(16).padStart(40, '0'),
    PAYMENT.payment_recipient.slice(2).toLowerCase());
  check('amount', result.public_signals.amount, PAYMENT.payment_amount);
  check('daily_spent_before', result.public_signals.daily_spent_before, PAYMENT.daily_spent_before);
  check('the off-circuit evaluator agrees', String(result.rules_agree), 'true');
  process.stdout.write('\n');

  // ------------------------------------------------------- 4. Arc verifies it
  const overrides = deployed
    ? undefined
    : {
      [SCRATCH]: {
        code: await stage('build verifier', async () => verifierBytecodeFor(vkPath)),
      },
    };
  const to = deployed ?? SCRATCH;
  const call = async (data) => {
    const params = [{ to, data }, 'latest'];
    if (overrides) params.push(overrides);
    return rpc('eth_call', params);
  };

  const calldata = calldataFor(result.solidity);
  const verified = await stage('verify', () => call(calldata));
  process.stdout.write('Arc verifies it\n');
  check('the proof verifies on chain', verified, TRUE);

  // ----------------------------------------------- 5. the negative control
  //
  // Substituting the commitment must break the proof. Without this the check
  // above shows only that something verified, not that the policy is bound to
  // it: the eight signals are covered by the pairing, so a different commitment
  // is a proof of a different statement.
  const otherPolicy = await buildCircuitInput({
    ...request, max_daily_spend: '999000000',
  });
  const otherCommitment = await policyDataHash(otherPolicy);
  if (otherCommitment === expectedCommitment) {
    throw new Error('the control policy hashes the same as the real one; the control proves nothing');
  }
  const swapped = await call(calldataFor(result.solidity, (words) => {
    const out = [...words];
    out[8 + 1] = `0x${BigInt(otherCommitment).toString(16).padStart(64, '0')}`;
    return out;
  }));
  check('a substituted policy commitment is rejected', swapped, FALSE);
  process.stdout.write('\n');

  // ----------------------------------------------------------- 6. what it cost
  const gas = Number(await rpc('eth_estimateGas', [{ to, data: calldata }, 'latest',
    ...(overrides ? [overrides] : [])]));
  process.stdout.write(`Arc gas for the verification: ${gas.toLocaleString('en-US')}\n`);
  const width = Math.max(...timings.map(([name]) => name.length), 5);
  for (const [name, ms] of timings) {
    process.stdout.write(`  ${name.padEnd(width)} ${ms.toFixed(0).padStart(6)} ms\n`);
  }
  const total = timings.reduce((a, [, ms]) => a + ms, 0);
  process.stdout.write(`  ${'total'.padEnd(width)} ${total.toFixed(0).padStart(6)} ms\n\n`);

  if (failures > 0) {
    process.stdout.write(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Policy committed, proof built from it, accepted by chain ${chainId} (${client}).\n`,
  );
}

await main();

// snarkjs leaves a worker pool up after fullProve and does not tear it down, so
// this finishes its work and then sits there. The failure path already exits;
// without this the success path does not, and the job runs to whatever ceiling
// is above it — six hours before timeout-minutes was added, fifteen minutes
// after. Both times the log showed every check passing and then nothing, which
// is what made it look like a hang rather than a process that had simply not
// returned.
process.exit(0);
