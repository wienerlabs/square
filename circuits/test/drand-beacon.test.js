// The beacon's trust anchor, and the substitution it used to accept.
//
// The beacon is what makes the phase-2 chain sound without trusting any
// contributor: a value nobody could predict while contributions were open,
// mixed in last. That property rests entirely on the value really being one
// drand's threshold produced. Before square#121 the script checked that against
// the group public key `api.drand.sh` handed it in the same response — which
// proves the host is self-consistent and nothing else — and the command that
// wrote the value into the final key did not check it at all.
//
// These tests are offline apart from the ones marked LIVE. The fixture below is
// quicknet's real /info, recorded so the recomputation can be exercised without
// a network and so a changed pin fails here rather than during a ceremony.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DRAND, chainHashOf, assertQuicknet, verifyDrandSignature, roundAt, timeOfRound,
} from '../scripts/ceremony.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');
const ZKEY = path.join(BUILD, 'payment.zkey');
const CEREMONY_DOCS = path.resolve(ROOT, '..', 'docs', 'ceremony');
const HAVE_ZKEY = fs.existsSync(ZKEY);

// GET https://api.drand.sh/v2/beacons/quicknet/info
const QUICKNET_INFO = Object.freeze({
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c'
    + '8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb'
    + '5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  genesis_seed: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  chain_hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  scheme: 'bls-unchained-g1-rfc9380',
  beacon_id: 'quicknet',
});

const LIVE = Boolean(process.env.LIVE);

describe('the pinned chain', () => {
  it('recomputes its own hash from the parameters it reports', async () => {
    expect(await chainHashOf(QUICKNET_INFO)).toBe(DRAND.chainHash);
  });

  it('pins the key the announced chain hash commits to', () => {
    expect(DRAND.publicKey).toBe(QUICKNET_INFO.public_key);
    expect(DRAND.genesisSeed).toBe(QUICKNET_INFO.genesis_seed);
    expect(DRAND.beaconId).toBe(QUICKNET_INFO.beacon_id);
  });

  it('accepts the real chain', async () => {
    await expect(assertQuicknet(QUICKNET_INFO)).resolves.toBeUndefined();
  });
});

// The substitution the old check waved through: a host answering for
// api.drand.sh serves its own group key, echoes the expected chain_hash string,
// and signs under the key it supplied.
describe('a host that answers for api.drand.sh', () => {
  it('cannot substitute a group key, because the hash no longer recomputes', async () => {
    const forged = { ...QUICKNET_INFO, public_key: `aa${QUICKNET_INFO.public_key.slice(2)}` };
    expect(await chainHashOf(forged)).not.toBe(DRAND.chainHash);
    await expect(assertQuicknet(forged)).rejects.toThrow(/do not hash to the announced chain/);
  });

  it('cannot get there by echoing the expected chain_hash string either', async () => {
    // chain_hash is never read. This is the whole point: the field the old code
    // compared is supplied by the party it is meant to check.
    const forged = {
      ...QUICKNET_INFO,
      public_key: `aa${QUICKNET_INFO.public_key.slice(2)}`,
      chain_hash: DRAND.chainHash,
    };
    await expect(assertQuicknet(forged)).rejects.toThrow(/do not hash to the announced chain/);
  });

  it('cannot move genesis or the period', async () => {
    await expect(assertQuicknet({ ...QUICKNET_INFO, genesis_time: 1692803368 }))
      .rejects.toThrow(/do not hash to the announced chain/);
    await expect(assertQuicknet({ ...QUICKNET_INFO, period: 30 }))
      .rejects.toThrow(/do not hash to the announced chain/);
  });

  it('cannot substitute the group seed', async () => {
    await expect(assertQuicknet({ ...QUICKNET_INFO, genesis_seed: `bb${QUICKNET_INFO.genesis_seed.slice(2)}` }))
      .rejects.toThrow(/do not hash to the announced chain/);
  });
});

describe('round arithmetic', () => {
  it('roundAt and timeOfRound are inverses', () => {
    for (const round of [1, 2, 1_000_000, 21_000_000]) {
      expect(roundAt(timeOfRound(round))).toBe(round);
    }
  });

  // Which is exactly why verify-chain's check on those two is arithmetic and
  // not evidence, and why square#121 stopped it reading like a timing check.
  it('is why the recorded round and lands_at can never disagree by themselves', () => {
    const round = 12_345_678;
    const landsAt = new Date(timeOfRound(round) * 1000).toISOString();
    expect(roundAt(Date.parse(landsAt) / 1000)).toBe(round);
  });
});

describe.skipIf(!LIVE)('against the live chain (LIVE=1)', () => {
  it('serves parameters that hash to the pinned chain', async () => {
    const info = await (await fetch(`${DRAND.api}/info`)).json();
    expect(await chainHashOf(info)).toBe(DRAND.chainHash);
    await expect(assertQuicknet(info)).resolves.toBeUndefined();
  }, 30_000);

  it('signs rounds verifiably under the pinned key', async () => {
    const latest = await (await fetch(`${DRAND.api}/rounds/latest`)).json();
    expect(await verifyDrandSignature(latest.round, latest.signature)).toBe(true);
    // A signature is bound to its round number; the message is sha256 of it.
    expect(await verifyDrandSignature(latest.round - 1, latest.signature)).toBe(false);
  }, 30_000);
});

describe.skipIf(LIVE)('against the live chain (LIVE=1)', () => {
  it('skipped: set LIVE=1 to check the pins against api.drand.sh', () => {
    expect(LIVE).toBe(false);
  });
});

// square#227. The beacon value has one spelling, and it is the round's BLS
// signature. `ceremony.mjs beacon` hands that string to `snarkjs zkey beacon`,
// and `verify-chain` compares what it reads back out of the key against the
// signature the chain publishes for the round. Two ceremony documents told the
// operator and the third party to use sha256 of the signature instead — 32
// bytes against 48 — so a key closed the documented way could never satisfy the
// check the code writes, and a key closed by the code could never satisfy the
// check the documents describe. Exactly one of the two could ever pass, and
// nothing ran both ends in the same place to notice.
//
// So they run in the same place now: apply a beacon to a real key, read it back
// with the inspector `verify-chain` itself uses, and compare.

// 48 bytes, the shape quicknet signs under bls-unchained-g1-rfc9380. Synthetic
// on purpose: what is under test is what snarkjs stores and what the inspector
// reads, and a value nobody has to fetch keeps this suite offline. The live
// block above is where a real round's signature is checked against the pin.
const SIGNATURE_96 = '8d8b1cd2a1e5f0c3b4a6978d2e3f4051'
  + '6273849506a7b8c9d0e1f20314253647'
  + '58697a8b9cad0e1f2031425364758697';

describe('the beacon value in the key', () => {
  it('cannot be both spellings: the lengths rule it out', () => {
    const digest = crypto.createHash('sha256').update(Buffer.from(SIGNATURE_96, 'hex')).digest('hex');
    expect(SIGNATURE_96).toHaveLength(96);
    expect(digest).toHaveLength(64);
    expect(digest).not.toBe(SIGNATURE_96);
  });

  it('is the signature in beacon.md, not a digest of it', () => {
    const doc = fs.readFileSync(path.join(CEREMONY_DOCS, 'beacon.md'), 'utf8');
    expect(doc).toContain('jq -r .signature');
    expect(doc).not.toMatch(/hashlib\.sha256\(bytes\.fromhex\([^)]*signature/);
  });

  it('is the signature in verifying.md, not a digest of it', () => {
    const doc = fs.readFileSync(path.join(CEREMONY_DOCS, 'verifying.md'), 'utf8');
    expect(doc).toContain('jq -r .signature');
    expect(doc).not.toMatch(/hashlib\.sha256\(bytes\.fromhex\([^)]*signature/);
  });
});

describe.skipIf(!HAVE_ZKEY)('what `zkey beacon` writes is what `verify-chain` reads', () => {
  it('stores the signature verbatim, all 48 bytes of it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-'));
    const closed = path.join(dir, 'final.zkey');
    try {
      // The same call `ceremony.mjs beacon` makes, with the same iteration
      // exponent it records.
      execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'snarkjs'),
        ['zkey', 'beacon', ZKEY, closed, SIGNATURE_96, '10', '--name=drand quicknet round 1'],
        { stdio: 'ignore' },
      );

      // The inspector verify-chain calls, reading the key rather than a claim
      // about it.
      const report = JSON.parse(execFileSync(
        'node',
        [path.join(ROOT, 'scripts', 'inspect-zkey-setup.mjs'), closed, '--json'],
        { encoding: 'utf8' },
      ));

      const beacons = report.contributions.filter((c) => c.kind === 'beacon');
      expect(report.beaconApplied).toBe(true);
      expect(beacons).toHaveLength(1);
      expect(beacons[0].numIterationsExp).toBe(10);

      // This comparison is verify-chain's, character for character:
      //   beacons[0].beaconHash?.toLowerCase() === live.signature.toLowerCase()
      // With the documented sha256 spelling in the key, it reads 64 characters
      // here and fails.
      expect(beacons[0].beaconHash.toLowerCase()).toBe(SIGNATURE_96.toLowerCase());
      expect(beacons[0].beaconHash).toHaveLength(96);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(HAVE_ZKEY)('what `zkey beacon` writes is what `verify-chain` reads', () => {
  it('skipped: build the development key first (npm run build)', () => {
    expect(HAVE_ZKEY).toBe(false);
  });
});
