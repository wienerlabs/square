// What the inspector reports about a key that has been closed with a beacon.
//
// square#233. The phase-2 count came from the unfiltered contribution list, so
// a `snarkjs zkey beacon` record — type 1, not a contributor — was counted as
// one. Every beacon-applied key reported one participant too many, which is the
// number `ceremony.mjs` writes into the published transcript
// (`phase2_contributions`) and the number CI prints on every run under a step
// whose comment says it is read out of the binary rather than taken from a
// claim in a README.
//
// Measured before the fix, on a key with one contribution and one beacon:
//
//   phase-2 contributions    2
//   beacon applied           yes
//   phase 2: 2 contributions with a beacon applied.
//
// The key here is real rather than hand-written: the development key already
// carries one contribution, and `snarkjs zkey beacon` adds the beacon record,
// so the shapes are the ones the ceremony will actually produce.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ZKEY = path.join(ROOT, 'build', 'payment.zkey');
const SNARKJS = path.join(ROOT, 'node_modules', '.bin', 'snarkjs');
const HAVE_ZKEY = fs.existsSync(ZKEY);

// 48 bytes, the shape drand quicknet signs. The value is not under test here —
// square#227 covers what gets written — only that the record it produces is
// counted as a beacon and not as a contributor.
const SIGNATURE = '8d8b1cd2a1e5f0c3b4a6978d2e3f4051'
  + '6273849506a7b8c9d0e1f20314253647'
  + '58697a8b9cad0e1f2031425364758697';

const inspect = (file, json = true) =>
  execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'inspect-zkey-setup.mjs'), file, ...(json ? ['--json'] : [])],
    { encoding: 'utf8' },
  );

describe.skipIf(!HAVE_ZKEY)('a key closed with a beacon', () => {
  let dir;
  let closed;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-beacon-count-'));
    closed = path.join(dir, 'payment_final.zkey');
    execFileSync(
      SNARKJS,
      ['zkey', 'beacon', ZKEY, closed, SIGNATURE, '10', '--name=drand quicknet round 1'],
      { stdio: 'ignore' },
    );
  }, 120_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts the contributor and not the beacon', () => {
    const report = JSON.parse(inspect(closed));
    expect(report.contributions.map((c) => c.kind)).toEqual(['contribute', 'beacon']);
    expect(report.phase2ContributionCount).toBe(1);
    expect(report.beaconApplied).toBe(true);
  });

  // The count and the list have to agree, because `ceremony.mjs` derives its
  // own from the list — `report.contributions.filter(c => c.kind ===
  // 'contribute')` — and publishes this one in the transcript. Two numbers for
  // one fact is how they drifted apart.
  it('reports the number verify-chain derives from the same report', () => {
    const report = JSON.parse(inspect(closed));
    const derived = report.contributions.filter((c) => c.kind === 'contribute').length;
    expect(report.phase2ContributionCount).toBe(derived);
  });

  it('says so in the summary a reader sees', () => {
    const summary = inspect(closed, false);
    expect(summary).toContain('phase-2 contributions    1');
    expect(summary).toContain('beacon applied           yes');
    expect(summary).toContain('1 contribution with a beacon applied');
  });

  // The development key is the other half of the pair: one contribution, no
  // beacon. It is what ptau-adoption.test.js asserts on, and the fix must leave
  // it alone.
  it('leaves a key with no beacon reading exactly as before', () => {
    const report = JSON.parse(inspect(ZKEY));
    expect(report.phase2ContributionCount).toBe(1);
    expect(report.beaconApplied).toBe(false);
  });
});

describe.skipIf(HAVE_ZKEY)('a key closed with a beacon', () => {
  it('skipped: build the development key first (npm run build)', () => {
    expect(HAVE_ZKEY).toBe(false);
  });
});
