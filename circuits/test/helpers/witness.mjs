// Compute a witness for a compiled circuit, in memory.
//
// Two wrinkles are handled here so the tests do not have to.
//
// circom emits `<circuit>_js/witness_calculator.js` next to the wasm. It is a
// CommonJS module that also assigns to an undeclared global inside its
// array-input path, so in a "type": "module" package Node loads it as ESM and
// it fails twice over — once on `module.exports`, once on the implicit global
// under strict mode. Copying it to `.cjs` and requiring it puts it back in the
// loader and the sloppy mode it was written for.
//
// The obvious alternative, snarkjs.wtns.calculate, writes the witness to a file
// and leaks its FileHandle when a constraint fails — which is precisely the
// path the negative tests take, and Node 26 turns that into an uncaught error
// on garbage collection. Working in memory avoids the question.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILD = path.resolve(HERE, '..', '..', 'build');

const require = createRequire(import.meta.url);
const calculators = new Map();

export const wasmPath = (circuit) =>
  path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`);

export const isBuilt = (circuit) => fs.existsSync(wasmPath(circuit));

async function getCalculator(circuit) {
  if (calculators.has(circuit)) return calculators.get(circuit);

  const dir = path.join(BUILD, `${circuit}_js`);
  const source = path.join(dir, 'witness_calculator.js');
  const commonjs = path.join(dir, 'witness_calculator.cjs');

  // Refresh the copy whenever circom has regenerated the original.
  const stale = !fs.existsSync(commonjs)
    || fs.statSync(commonjs).mtimeMs < fs.statSync(source).mtimeMs;
  if (stale) fs.copyFileSync(source, commonjs);

  const build = require(commonjs);
  const calculator = await build(fs.readFileSync(wasmPath(circuit)));
  calculators.set(circuit, calculator);
  return calculator;
}

// Returns the witness as decimal strings, index 0 being the constant 1.
// Throws when the input violates a constraint, which is what the negative
// tests assert on.
export async function calculateWitness(circuit, input) {
  const calculator = await getCalculator(circuit);
  const witness = await calculator.calculateWitness(input, true);
  return witness.map((v) => v.toString());
}
