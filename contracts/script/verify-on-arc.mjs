#!/usr/bin/env node
// Verify a real proof against Arc's own EVM, without deploying anything.
//
// The verifier's whole job is a bn128 pairing, and pairings run on precompiles
// 0x06/0x07/0x08. Those are consensus-level code, so "the proof verifies in
// Foundry" and "the proof verifies on Arc" are different claims: the first says
// the contract is right, the second says Arc's precompiles agree with revm's.
// Only the second is the one #17 asks for.
//
// This gets that without a funded key by using an eth_call state override —
// the node runs the verifier's bytecode at a scratch address for the duration
// of one call. It is the real chain, the real precompiles and the real
// bytecode; the only thing missing is a transaction, and a view call would not
// have written anything anyway.
//
// A deployment is still needed for the address #17 wants in the README. This
// exists because the verification result should not have to wait on funding,
// and because it stays runnable afterwards by anyone without an account.
//
//   node script/verify-on-arc.mjs            verify, and report Arc's gas
//   node script/verify-on-arc.mjs --address 0x…   use a deployed verifier
//
// ARC_RPC_URL overrides the endpoint.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io';
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'proofs.json');

// verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])
const SELECTOR = '0xc9219a7a';
// Any address with no code on Arc. Only used with a state override.
const SCRATCH = '0x00000000000000000000000000000000000c0de0';

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function runtimeBytecode() {
  return execFileSync(
    'forge',
    ['inspect', 'src/Groth16Verifier.sol:Groth16Verifier', 'deployedBytecode'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
}

// The proof and its eight public signals, flattened in the order the ABI wants.
function calldataFor(proof, mutate = (words) => words) {
  const words = mutate([
    ...proof.a, ...proof.b[0], ...proof.b[1], ...proof.c, ...proof.input,
  ]);
  return SELECTOR + words.map((w) => w.slice(2)).join('');
}

async function main() {
  const argv = process.argv.slice(2);
  const addressFlag = argv.indexOf('--address');
  const deployed = addressFlag >= 0 ? argv[addressFlag + 1] : null;

  if (!fs.existsSync(FIXTURES)) {
    throw new Error('test/fixtures/proofs.json is missing; run script/regenerate-fixtures.mjs');
  }
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));

  const chainId = Number(await rpc('eth_chainId', []));
  const block = Number(await rpc('eth_blockNumber', []));
  process.stdout.write(`rpc      ${RPC}\nchain id ${chainId}\nblock    ${block}\n\n`);

  const to = deployed ?? SCRATCH;
  const overrides = deployed ? [] : [{ [SCRATCH]: { code: runtimeBytecode() } }];
  process.stdout.write(
    deployed
      ? `verifier ${deployed} (deployed)\n\n`
      : 'verifier state override at a scratch address (nothing deployed)\n\n',
  );

  const call = (data) => rpc('eth_call', [{ to, data }, 'latest', ...overrides]);
  const TRUE = `0x${'0'.repeat(63)}1`;
  const FALSE = `0x${'0'.repeat(64)}`;

  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures += 1;
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}\n`);
  };

  process.stdout.write('a proof the prover service produced\n');
  check('compliant proof verifies', await call(calldataFor(fixtures.compliant)), TRUE);
  check(
    'non-compliant proof also verifies — is_compliant is a signal, not a gate',
    await call(calldataFor(fixtures.blocked)),
    TRUE,
  );

  process.stdout.write('\ntampering is rejected\n');
  // input starts after 8 proof words; is_compliant is input[0], amount input[3].
  const flipCompliance = (w) => { w[8] = `0x${'0'.repeat(63)}1`; return w; };
  const bumpAmount = (w) => { w[11] = `0x${(5_000_001).toString(16).padStart(64, '0')}`; return w; };
  check(
    'flipped is_compliant',
    await call(calldataFor(fixtures.blocked, flipCompliance)),
    FALSE,
  );
  check(
    'altered amount',
    await call(calldataFor(fixtures.compliant, bumpAmount)),
    FALSE,
  );

  const gas = Number(await rpc('eth_estimateGas', [
    { to, data: calldataFor(fixtures.compliant) }, 'latest', ...overrides,
  ]));
  process.stdout.write(`\nArc gas for one verification: ${gas}\n`);
  process.stdout.write('  (whole call: 21000 base + calldata + execution)\n');

  if (failures > 0) {
    process.stderr.write(`\n${failures} check(s) failed\n`);
    return 1;
  }
  process.stdout.write('\nAll checks passed against Arc.\n');
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}
