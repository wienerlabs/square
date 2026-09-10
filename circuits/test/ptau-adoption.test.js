// The adopted phase-1 powers of tau, and the checks that keep it honest.
//
// docs/ceremony/phase1-ptau.md records which file this project builds on. That
// record is only worth something if the build refuses anything else and the
// tooling can tell, from a finished key, that the file was actually used. Both
// are asserted here rather than left to a document nobody re-reads.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADOPTED, ptauPath, verifyPtau } from '../scripts/fetch-ptau.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');
const ZKEY = path.join(BUILD, 'payment.zkey');

const HAVE_PTAU = fs.existsSync(ptauPath());
const HAVE_ZKEY = fs.existsSync(ZKEY);

describe('the adoption record', () => {
  it('names one file, one ceremony and one contribution', () => {
    expect(ADOPTED.ceremony).toBe('Perpetual Powers of Tau');
    expect(ADOPTED.contribution).toBe(80);
    expect(ADOPTED.file).toBe('ppot_0080_14.ptau');
  });

  it('is big enough for the circuit and no bigger', () => {
    // payment.circom's domain size is 16384 = 2^14 as of square#45, so 14 is
    // the smallest truncation that fits. Larger buys nothing and costs
    // bandwidth: the download is already 19 MB rather than 9.5.
    expect(ADOPTED.power).toBe(14);
    expect(2 ** ADOPTED.power).toBe(16384);
  });

  it('carries hashes in the shape a hash check can use', () => {
    expect(ADOPTED.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ADOPTED.blake2b).toMatch(/^[0-9a-f]{128}$/);
    expect(ADOPTED.bytes).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAVE_PTAU)('the file on disk', () => {
  it('is the adopted one', () => {
    const result = verifyPtau();
    expect(result.sha256).toBe(ADOPTED.sha256);
    expect(result.blake2b).toBe(ADOPTED.blake2b);
    expect(result.bytes).toBe(ADOPTED.bytes);
  });

  it('rejects a file of the right length whose contents differ', () => {
    // The interesting failure: something that passes a size check but is not
    // the file. A truncation check alone would let this through.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptau-'));
    const tampered = path.join(dir, ADOPTED.file);
    try {
      const bytes = fs.readFileSync(ptauPath());
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(tampered, bytes);
      expect(() => verifyPtau(tampered)).toThrow(/does not hash to the adopted file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a truncated file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptau-'));
    const short = path.join(dir, ADOPTED.file);
    try {
      fs.writeFileSync(short, fs.readFileSync(ptauPath()).subarray(0, 1024));
      expect(() => verifyPtau(short)).toThrow(/bytes, expected/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing file rather than pretending', () => {
    expect(() => verifyPtau(path.join(BUILD, 'no-such.ptau')))
      .toThrow(/not present/);
  });
});

describe.skipIf(!HAVE_ZKEY)('a key built here', () => {
  const inspect = (file) =>
    execFileSync('node', [path.join(ROOT, 'scripts', 'inspect-zkey-setup.mjs'), file, '--json'],
      { encoding: 'utf8' });

  it('is recognisably built on the adopted ceremony', () => {
    // The point of the whole exercise: not that a document says which powers of
    // tau was used, but that the finished key says it, and can be asked.
    const report = JSON.parse(inspect(ZKEY));
    expect(report.phase1.recognisedCeremony)
      .toBe('Perpetual Powers of Tau, contribution 80 (ppot_0080_*)');
  });

  it('still reports phase 2 as a development contribution', () => {
    // Adopting phase 1 does not make the key a ceremony output. #16 is what
    // changes this assertion, and it should fail loudly when it does.
    const report = JSON.parse(inspect(ZKEY));
    expect(report.phase2ContributionCount).toBe(1);
    expect(report.beaconApplied).toBe(false);
  });

  it('exposes the eight public signals the circuit declares', () => {
    const report = JSON.parse(inspect(ZKEY));
    expect(report.nPublic).toBe(8);
  });

  // The assertion above states the power. This one derives it, so the two
  // cannot drift apart the way they did in square#45.
  //
  // The trap that caught that change: circom prints "non-linear constraints"
  // and it is tempting to size the ptau from it, but snarkjs sizes the domain
  // from the *total* constraint count. The salted commitment took non-linear
  // constraints from 2,609 to 4,721 — comfortably inside 8,192 — while the
  // total went from 6,586 to 11,426, which is not. `groth16 setup` refused,
  // which is the right failure, but it refused at build time in CI rather than
  // here where it can say why.
  it('is exactly the smallest power the built key needs', () => {
    const report = JSON.parse(inspect(ZKEY));
    const domain = report.domainSize;
    expect(Number.isInteger(Math.log2(domain))).toBe(true);

    expect(2 ** ADOPTED.power).toBeGreaterThanOrEqual(domain);
    // And no larger than it has to be.
    expect(2 ** (ADOPTED.power - 1)).toBeLessThan(domain);
  });
});
