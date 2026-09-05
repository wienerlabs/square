#!/usr/bin/env node
// Fetch the adopted phase-1 powers of tau, and refuse to hand back a file whose
// hash is not the one we adopted.
//
// Phase 1 is the universal half of the setup: it is not circuit-specific and it
// does not have to be run by us, which is the whole point of a perpetual
// ceremony. What we do have to do is say exactly which file we took, prove the
// bytes are that file, and make it reproducible for anyone who wants to check.
// docs/ceremony/phase1-ptau.md carries the provenance; this script enforces it.
//
// The hash is the trust anchor, not the host. A mirror is fine — the file is
// either the one that hashes to ADOPTED.sha256 or it is refused. That matters
// more than usual here: the URL the ecosystem has pointed at for years, and
// that snarkjs and circomkit still print, now returns 403, so anyone building
// this circuit has to get the file from somewhere else.
//
//   node scripts/fetch-ptau.mjs            fetch if missing, then verify
//   node scripts/fetch-ptau.mjs --verify   verify what is already on disk
//   node scripts/fetch-ptau.mjs --print    print the adopted parameters

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');

// The adopted phase-1 file.
//
// Power 13 is the smallest that fits payment.circom: the circuit's domain size
// is 8192 = 2^13. Taking the smallest sufficient truncation keeps the download
// at 9.5 MB instead of 19, and a larger one buys nothing — the excess powers are
// never touched.
export const ADOPTED = Object.freeze({
  ceremony: 'Perpetual Powers of Tau',
  contribution: 80,
  file: 'ppot_0080_13.ptau',
  power: 13,
  bytes: 9530514,
  sha256: 'ccee28086e4b81d81a6e16fdee054d1dbd5276362e2662d4205d31de45cb930f',
  blake2b:
    'bf0c2d498f1197ad04ec0dbfcdda6df6348cbd793759f1f986e5cdf1a4100842'
    + '293dfad6b8961f64b7ba35c162b5c821c4c097a52f3a639b55b0e765ec311b44',
  // Published by the ceremony's own repository,
  // github.com/privacy-ethereum/perpetualpowersoftau.
  url: 'https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_13.ptau',
});

export const ptauPath = () => path.join(BUILD, ADOPTED.file);

function digest(algorithm, file) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function verifyPtau(file = ptauPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.basename(file)} is not present; run scripts/fetch-ptau.mjs`);
  }
  const size = fs.statSync(file).size;
  if (size !== ADOPTED.bytes) {
    throw new Error(
      `${path.basename(file)} is ${size} bytes, expected ${ADOPTED.bytes}. `
      + 'Delete it and fetch again.',
    );
  }
  const sha256 = digest('sha256', file);
  if (sha256 !== ADOPTED.sha256) {
    throw new Error(
      `${path.basename(file)} does not hash to the adopted file.\n`
      + `  expected sha256 ${ADOPTED.sha256}\n`
      + `  got             ${sha256}\n`
      + 'Refusing to build a proving key on an unidentified powers of tau.',
    );
  }
  return { sha256, blake2b: digest('blake2b512', file), bytes: size };
}

async function download(url, destination) {
  process.stdout.write(`fetching ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} from ${url}\n`
      + 'The ceremony repository lists mirrors: '
      + 'https://github.com/privacy-ethereum/perpetualpowersoftau\n'
      + `Any mirror is fine — the file is checked against sha256 ${ADOPTED.sha256}.`,
    );
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, destination);
}

export async function ensurePtau() {
  const file = ptauPath();
  if (!fs.existsSync(file)) await download(ADOPTED.url, file);
  return { file, ...verifyPtau(file) };
}

async function main(argv) {
  if (argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify(ADOPTED, null, 2)}\n`);
    return 0;
  }

  const file = ptauPath();
  if (argv.includes('--verify')) {
    const result = verifyPtau(file);
    process.stdout.write(
      `${ADOPTED.file}\n`
      + `  ${result.bytes} bytes\n`
      + `  sha256  ${result.sha256}\n`
      + `  blake2b ${result.blake2b}\n`
      + `  matches the adopted ${ADOPTED.ceremony} contribution ${ADOPTED.contribution}\n`,
    );
    return 0;
  }

  const result = await ensurePtau();
  process.stdout.write(
    `${result.file}\n`
    + `  ${result.bytes} bytes, sha256 ${result.sha256}\n`
    + `  verified against the adopted ${ADOPTED.ceremony} contribution ${ADOPTED.contribution}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
