// The contributions in the key, against the ones the transcript claims.
//
// square#229. `verify-chain` compared the two lists' lengths and printed
// "matching the transcript". `contribute` records the two values that would make
// that sentence true — `transcript_hash`, the hash snarkjs prints and the
// contributor publishes, and `recorded_name`, the name written into the key —
// and nothing read either of them back.
//
// The attack that opens: run the real ceremony with outside contributors,
// publish their transcripts, then quietly re-run the chain with your own
// contributions and publish that key. `snarkjs zkey verify` passes on the
// substituted chain, the count matches, the beacon is real, and every trapdoor
// belongs to the publisher.
//
// The pure function is tested on its own because it is the whole check, and on
// the real development key because the shapes it reads come from the inspector
// rather than from this file's idea of them.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contributionMismatches } from '../scripts/ceremony.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ZKEY = path.join(ROOT, 'build', 'payment.zkey');
const HAVE_ZKEY = fs.existsSync(ZKEY);

// The shape the inspector reports, and the shape `contribute` writes.
const held = (name, transcriptHash) => ({ name, transcriptHash });
const claimed = (name, hash) => ({
  index: 1,
  name,
  recorded_name: name,
  transcript_hash: hash,
  zkey_sha256: 'f'.repeat(64),
  at: '2026-09-01T00:00:00.000Z',
});

const ALICE = '1'.repeat(128);
const BOB = '2'.repeat(128);

describe('a transcript that describes the key', () => {
  it('agrees when the names and hashes are the ones the key carries', () => {
    const problems = contributionMismatches(
      [held('Alice', ALICE), held('Bob', BOB)],
      [claimed('Alice', ALICE), claimed('Bob', BOB)],
    );
    expect(problems).toEqual([]);
  });

  it('does not mind the case a hash is written in', () => {
    const problems = contributionMismatches(
      [held('Alice', ALICE.toUpperCase())],
      [claimed('Alice', ALICE)],
    );
    expect(problems).toEqual([]);
  });
});

describe('a transcript that does not', () => {
  // The measurement in the issue: a transcript naming Alice and Bob over a key
  // whose two contributions are the operator's own.
  it('catches a chain re-run by the publisher, which the count alone waved through', () => {
    const substituted = [held('Zeta (the operator, three times)', '0101'.repeat(32)),
      held('Zeta again', '0202'.repeat(32))];
    const published = [claimed('Alice', ALICE), claimed('Bob', BOB)];

    expect(substituted).toHaveLength(published.length);

    const problems = contributionMismatches(substituted, published);
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('contribution 1 (Alice)');
    expect(problems.join('\n')).toContain('contribution 2 (Bob)');
  });

  it('catches one hash changed and nothing else', () => {
    const problems = contributionMismatches(
      [held('Alice', ALICE), held('Bob', `3${BOB.slice(1)}`)],
      [claimed('Alice', ALICE), claimed('Bob', BOB)],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('contribution 2 (Bob)');
    expect(problems[0]).toContain('transcript hash');
  });

  it('catches one name changed and nothing else', () => {
    const problems = contributionMismatches(
      [held('Alice', ALICE), held('Bobby', BOB)],
      [claimed('Alice', ALICE), claimed('Bob', BOB)],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"Bobby"');
    expect(problems[0]).toContain('"Bob"');
  });

  // A Groth16 phase-2 chain is sequential, so the same two contributions in the
  // other order are a different chain, not a rearranged record of this one.
  it('is positional: the same pair out of order is a mismatch', () => {
    const problems = contributionMismatches(
      [held('Bob', BOB), held('Alice', ALICE)],
      [claimed('Alice', ALICE), claimed('Bob', BOB)],
    );
    expect(problems).toHaveLength(4);
  });

  it('catches a contribution the key does not hold', () => {
    const problems = contributionMismatches([held('Alice', ALICE)], [claimed('Alice', ALICE), claimed('Bob', BOB)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the key holds none');
  });

  it('catches a contribution the transcript does not record', () => {
    const problems = contributionMismatches([held('Alice', ALICE), held('Bob', BOB)], [claimed('Alice', ALICE)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the transcript does not record');
  });

  // A transcript from before square#229 carries no hash. Saying so is the
  // answer; treating a missing hash as a match is how this started.
  it('refuses to read a missing hash as agreement', () => {
    const withoutHash = { ...claimed('Alice', ALICE), transcript_hash: undefined };
    const problems = contributionMismatches([held('Alice', ALICE)], [withoutHash]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('records no hash');
  });
});

describe.skipIf(!HAVE_ZKEY)('against the development key', () => {
  const contributionsOf = (file) => {
    const report = JSON.parse(execFileSync(
      'node',
      [path.join(ROOT, 'scripts', 'inspect-zkey-setup.mjs'), file, '--json'],
      { encoding: 'utf8' },
    ));
    return report.contributions.filter((c) => c.kind === 'contribute');
  };

  it('reads the fields the check compares out of a real key', () => {
    const contributions = contributionsOf(ZKEY);
    expect(contributions.length).toBeGreaterThan(0);
    for (const contribution of contributions) {
      expect(contribution.name).toBeTruthy();
      expect(contribution.transcriptHash).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('agrees with a transcript written from that key, and not with one edited after', () => {
    const contributions = contributionsOf(ZKEY);
    const transcript = contributions.map((c, i) => ({
      index: i + 1,
      name: c.name,
      recorded_name: c.name,
      transcript_hash: c.transcriptHash,
    }));
    expect(contributionMismatches(contributions, transcript)).toEqual([]);

    const edited = transcript.map((entry) => ({ ...entry, transcript_hash: `0${entry.transcript_hash.slice(1)}` }));
    expect(contributionMismatches(contributions, edited)).toHaveLength(contributions.length);
  });
});

describe.skipIf(HAVE_ZKEY)('against the development key', () => {
  it('skipped: build the development key first (npm run build)', () => {
    expect(HAVE_ZKEY).toBe(false);
  });
});
