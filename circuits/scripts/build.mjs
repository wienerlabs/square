#!/usr/bin/env node
// Compile the circuits and produce a development proving key.
//
// Phase 1 is real. It is the adopted Perpetual Powers of Tau contribution 80,
// fetched and hash-checked by scripts/fetch-ptau.mjs: 80 public contributions,
// none of them ours. Phase 2 is not real — it is a single contribution from
// this machine with no beacon — so the key as a whole is still a development
// key and nothing built on it carries an assurance claim.
//
// mandate#16 replaces phase 2 with a multi-party chain and a beacon. Until it
// lands, see docs/disclosure/zk-setup-status.md.
//
// Read what a key actually is rather than trusting this comment:
//   node scripts/inspect-zkey-setup.mjs build/payment.zkey
//
//   node scripts/build.mjs            compile everything, then a dev zkey
//   node scripts/build.mjs --no-zkey  compile only (what the tests need)
//
// Outputs land in build/ and are gitignored.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPTED, ensurePtau } from './fetch-ptau.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');


const CIRCUITS = [
  { name: 'payment', file: 'payment.circom' },
  { name: 'timestamp_checked', file: 'test/circuits/timestamp_checked.circom' },
  { name: 'timestamp_unchecked', file: 'test/circuits/timestamp_unchecked.circom' },
];

function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${cmd} ${args.join(' ')}\n`);
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function have(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

for (const tool of ['circom', 'snarkjs']) {
  if (!have(tool)) {
    process.stderr.write(
      `error: ${tool} is not on PATH.\n` +
      '  circom:  https://docs.circom.io/getting-started/installation/\n' +
      '  snarkjs: npm install -g snarkjs\n',
    );
    process.exit(1);
  }
}

fs.mkdirSync(BUILD, { recursive: true });

for (const { name, file } of CIRCUITS) {
  process.stdout.write(`\n--- compiling ${name} ---\n`);
  run('circom', [file, '--r1cs', '--wasm', '--sym', '-l', 'node_modules', '-o', BUILD]);
}

if (process.argv.includes('--no-zkey')) {
  process.stdout.write('\ncompiled; skipping the dev proving key (--no-zkey)\n');
  process.exit(0);
}

// Phase 1: the adopted public ceremony, not something generated here. The fetch
// refuses any file that does not hash to the adopted one, so a proving key can
// never quietly end up standing on an unidentified tau.
process.stdout.write(`\n--- phase 1: ${ADOPTED.ceremony} contribution ${ADOPTED.contribution} ---\n`);
const ptau = await ensurePtau();
process.stdout.write(`${ADOPTED.file}  sha256 ${ptau.sha256}  verified\n`);
const potFinal = ptau.file;

process.stdout.write('\n--- phase 2: development contribution (NOT a ceremony) ---\n');
const zkey0 = path.join(BUILD, 'payment_0.zkey');
const zkey = path.join(BUILD, 'payment.zkey');
const entropy = Buffer.from(
  globalThis.crypto.getRandomValues(new Uint8Array(32)),
).toString('base64');
run('snarkjs', ['groth16', 'setup', path.join(BUILD, 'payment.r1cs'), potFinal, zkey0]);
run('snarkjs', ['zkey', 'contribute', zkey0, zkey, '--name=dev-only', `-e=${entropy}`]);
run('snarkjs', ['zkey', 'export', 'verificationkey', zkey, path.join(BUILD, 'payment_vk.json')]);

process.stdout.write(
  '\nbuild/payment.zkey has a real phase 1 and a development phase 2.\n'
  + 'It is a DEVELOPMENT key until mandate#16 runs the phase-2 ceremony. Check it:\n'
  + '  node scripts/inspect-zkey-setup.mjs build/payment.zkey\n',
);
