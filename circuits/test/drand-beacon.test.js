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
import {
  DRAND, chainHashOf, assertQuicknet, verifyDrandSignature, roundAt, timeOfRound,
} from '../scripts/ceremony.mjs';

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
