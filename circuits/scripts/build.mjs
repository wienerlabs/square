#!/usr/bin/env node
// Compile the circuits and produce a development proving key.
//
// The key this makes is NOT a ceremony output. It exists so tests and the
// prover service can run; both phases of its setup are single-machine. The real
// ceremony is mandate#16, and until it lands nothing built here carries an
// assurance claim — see docs/disclosure/zk-setup-status.md.
//
//   node scripts/build.mjs            compile everything, then a dev zkey
//   node scripts/build.mjs --no-zkey  compile only (what the tests need)
//
// Outputs land in build/ and are gitignored.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');

// Powers of tau size. The main circuit is ~2.6k non-linear constraints, so 2^13
// is the smallest that fits; 13 keeps the dev setup fast.
const POT_POWER = 13;

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

const potFinal = path.join(BUILD, `pot${POT_POWER}_final.ptau`);
if (!fs.existsSync(potFinal)) {
  process.stdout.write('\n--- development powers of tau (NOT a ceremony) ---\n');
  const pot0 = path.join(BUILD, `pot${POT_POWER}_0.ptau`);
  const pot1 = path.join(BUILD, `pot${POT_POWER}_1.ptau`);
  // Entropy from the OS rather than a literal, so two builds never share a tau
  // and nobody can mistake this for a reproducible artifact.
  const entropy = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString('base64');
  run('snarkjs', ['powersoftau', 'new', 'bn128', String(POT_POWER), pot0, '-v']);
  run('snarkjs', ['powersoftau', 'contribute', pot0, pot1, '--name=dev-only', `-e=${entropy}`]);
  run('snarkjs', ['powersoftau', 'prepare', 'phase2', pot1, potFinal, '-v']);
}

process.stdout.write('\n--- development proving key (NOT a ceremony) ---\n');
const zkey0 = path.join(BUILD, 'payment_0.zkey');
const zkey = path.join(BUILD, 'payment.zkey');
const entropy = Buffer.from(
  globalThis.crypto.getRandomValues(new Uint8Array(32)),
).toString('base64');
run('snarkjs', ['groth16', 'setup', path.join(BUILD, 'payment.r1cs'), potFinal, zkey0]);
run('snarkjs', ['zkey', 'contribute', zkey0, zkey, '--name=dev-only', `-e=${entropy}`]);
run('snarkjs', ['zkey', 'export', 'verificationkey', zkey, path.join(BUILD, 'payment_vk.json')]);

process.stdout.write('\nbuild/payment.zkey is a DEVELOPMENT key. Check what it is with:\n');
process.stdout.write('  node scripts/inspect-zkey-setup.mjs build/payment.zkey\n');
