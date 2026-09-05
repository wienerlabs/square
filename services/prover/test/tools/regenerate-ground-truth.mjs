#!/usr/bin/env node
// Regenerate test/fixtures/circuit-ground-truth.json from the compiled circuit.
//
// The rule tests assert that src/rules.js agrees with payment.circom. That
// assertion is only worth anything if the expected values come from the circuit
// rather than from someone's reading of it, so they are produced here by
// running each fixture through the real witness calculator.
//
// Run it whenever the circuit changes — #14 re-parameterises it to eight public
// signals, which will change both the values and OUTPUT_ORDER below.
//
//   circom payment.circom --r1cs --wasm --sym -l node_modules -o build
//   node test/tools/regenerate-ground-truth.mjs --wasm-dir <path>/build/payment_js
//
// The circuit itself is not in this repository yet; it arrives with #14. Until
// then, point --wasm-dir at a build of aperture/circuits/payment-prover.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');

// Public outputs in payment.circom declaration order. The witness lays out
// w[0] = 1, then the public outputs, then public inputs, then private signals,
// so is_compliant is w[1].
const OUTPUT_ORDER = [
  'is_compliant',
  'policy_data_hash',
  'recipient_high',
  'recipient_low',
  'amount_lamports',
  'token_mint_high',
  'token_mint_low',
  'daily_spent_before',
  'current_unix_timestamp',
  'stripe_receipt_hash',
];

function parseArgs(argv) {
  const idx = argv.indexOf('--wasm-dir');
  const dir = idx >= 0 ? argv[idx + 1] : process.env.PROVER_CIRCUIT_WASM_DIR;
  if (!dir) {
    process.stderr.write(
      'usage: node test/tools/regenerate-ground-truth.mjs --wasm-dir <build>/payment_js\n' +
      '       (or set PROVER_CIRCUIT_WASM_DIR)\n',
    );
    process.exit(2);
  }
  return path.resolve(dir);
}

const wasmDir = parseArgs(process.argv.slice(2));
const { default: buildWitnessCalculator } = await import(
  path.join(wasmDir, 'witness_calculator.js')
);
const wasm = fs.readFileSync(path.join(wasmDir, 'payment.wasm'));

const results = {};
for (const file of fs.readdirSync(FIXTURES).sort()) {
  if (!file.endsWith('.json')) continue;
  if (file.includes('expected') || file.includes('ground-truth')) continue;

  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  if (input.stripe_receipt_hash_in === undefined) input.stripe_receipt_hash_in = '0';

  const calculator = await buildWitnessCalculator(wasm);
  const witness = await calculator.calculateWitness(input, true);

  const outputs = {};
  OUTPUT_ORDER.forEach((name, i) => { outputs[name] = witness[1 + i].toString(); });
  results[file] = outputs;
  process.stdout.write(`${file.padEnd(34)} is_compliant=${outputs.is_compliant}\n`);
}

const target = path.join(FIXTURES, 'circuit-ground-truth.json');
fs.writeFileSync(target, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`\nwrote ${path.relative(process.cwd(), target)}\n`);
