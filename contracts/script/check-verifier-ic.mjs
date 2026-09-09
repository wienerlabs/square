#!/usr/bin/env node
// Bind the committed verifier's IC points to a freshly compiled circuit.
//
// square#121, finding 4. `contracts.yml` runs `forge test` against the
// committed verifier and committed fixtures; `circuits.yml` compiles the
// circuit and builds a fresh key. Neither looks at the other's output, so a
// change to payment.circom that alters the constraint system leaves a verifier
// behind that is silently for a different circuit.
//
// Only IC can be checked today, and only IC is worth checking:
//
//   ALPHA, BETA   come from the powers of tau. Already pinned, by the ppot_0080
//                 fingerprint in inspect-zkey-setup.mjs, which
//                 ptau-adoption.test.js verifies against a freshly built key on
//                 every run. That catches a swapped ptau, not an edited circuit.
//   GAMMA         the canonical BN254 G2 generator. The same constant for every
//                 circuit and every ptau, so it tests nothing.
//   DELTA         changes with every phase-2 contribution, and build.mjs draws
//                 fresh entropy each time, so no CI build can ever reproduce the
//                 committed value. A full verifying-key diff becomes possible
//                 only once square#16 fixes one delta.
//   IC0..IC8      derived from the r1cs and the ptau, and untouched by phase 2:
//                 snarkjs writes gamma as the generator and computes IC in
//                 section 3 of zkey_new.js, and zkey_contribute.js copies that
//                 section through, rescaling only sections 8 and 9 by 1/delta.
//                 So IC is stable across contributions and moves when the
//                 circuit does. It is the only group bound to the circuit.
//
// Scope, stated so nobody reads more into a green line: this catches a
// constraint-level change to the circuit. An arity or ordering change fails on
// nPublic === 8 first, and a circuit outgrowing the 8192 domain fails on the
// ptau power claim.
//
//   node script/check-verifier-ic.mjs <verification_key.json>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERIFIER = path.join(ROOT, 'src', 'Groth16Verifier.sol');

const vkPath = process.argv[2];
if (!vkPath) {
  process.stderr.write(
    'usage: node script/check-verifier-ic.mjs <verification_key.json>\n\n'
    + 'The key of a freshly built circuit, for example\n'
    + '  cd circuits && npm run build   # writes build/payment_vk.json\n',
  );
  process.exit(2);
}

const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
if (vk.protocol !== 'groth16' || vk.curve !== 'bn128') {
  process.stderr.write(`expected a groth16 bn128 key, got ${vk.protocol} ${vk.curve}\n`);
  process.exit(1);
}
if (vk.nPublic !== 8) {
  process.stderr.write(`the verifier is written for 8 public signals, this key has ${vk.nPublic}\n`);
  process.exit(1);
}
if (vk.IC.length !== 9) {
  process.stderr.write(`expected 9 IC points for 8 public signals, got ${vk.IC.length}\n`);
  process.exit(1);
}

const source = fs.readFileSync(VERIFIER, 'utf8');
function constantIn(name) {
  const match = source.match(new RegExp(`constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!match) {
    process.stderr.write(`${name} is not in src/Groth16Verifier.sol\n`);
    process.exit(1);
  }
  return BigInt(match[1]);
}

let failures = 0;
process.stdout.write(`verifier  src/Groth16Verifier.sol\n`);
process.stdout.write(`key       ${path.relative(process.cwd(), vkPath)}\n\n`);

for (let i = 0; i < 9; i++) {
  for (const [axis, index] of [['X', 0], ['Y', 1]]) {
    const name = `IC${i}_${axis}`;
    const committed = constantIn(name);
    const built = BigInt(vk.IC[i][index]);
    if (committed === built) {
      process.stdout.write(`  ok      ${name}\n`);
    } else {
      process.stdout.write(
        `  FAIL    ${name}\n            committed ${committed}\n            built     ${built}\n`,
      );
      failures += 1;
    }
  }
}

process.stdout.write('\n');
if (failures > 0) {
  process.stdout.write(
    `${failures} of 18 IC coordinates differ.\n\n`
    + 'The committed verifier is for a different circuit than the one that just\n'
    + 'compiled. Regenerate it from the new key and regenerate the fixtures with\n'
    + 'it — see contracts/README.md. A verifier from the old key rejects every\n'
    + 'proof from the new circuit, so this fails loudly at integration; catching\n'
    + 'it here is cheaper.\n',
  );
  process.exit(1);
}
process.stdout.write('The committed verifier is keyed to this circuit.\n');
