// The verifying key's provenance, and the self-reference that used to stand in
// for it.
//
// square#228. `verify-chain` compared `payment_vk.json` against
// `transcript.final.vk_sha256`, and `finalize` writes that field by hashing that
// same file: both sides of the comparison came from the party being audited.
// Nothing derived a verifying key from `payment_final.zkey`, so a real
// multi-party key, a real beacon and a verifying key whose delta trapdoor the
// publisher knows passed every check the script makes — and the verifying key is
// what reaches the chain, since `Groth16Verifier.sol`'s constants are generated
// from it.
//
// Same shape as the substitution square#121 removed from the beacon check, named
// in drand-beacon.test.js: "the field the old code compared is supplied by the
// party it is meant to check".
//
// These run against the development key, which is a real Groth16 zkey with a
// real phase 1; what is under test is the derivation, not the ceremony.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyingKeyMatches } from '../scripts/ceremony.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');
const ZKEY = path.join(BUILD, 'payment.zkey');
const VK = path.join(BUILD, 'payment_vk.json');

const HAVE_KEYS = fs.existsSync(ZKEY) && fs.existsSync(VK);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe.skipIf(!HAVE_KEYS)('the verifying key is derived from the key, not from the transcript', () => {
  it('accepts the key the zkey actually exports', async () => {
    const result = await verifyingKeyMatches(ZKEY, VK);
    expect(result).toEqual({ ok: true, reason: null });
  }, 120_000);

  // The measurement from the issue, reproduced: a delta nobody derived from the
  // zkey. A transcript recording this file's digest satisfies the old check
  // exactly — which is asserted here rather than described, so the reason this
  // test exists cannot quietly stop being true.
  it('refuses a verifying key nobody exported, however the transcript is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-vk-test-'));
    const forged = path.join(dir, 'payment_vk.json');
    try {
      const vk = JSON.parse(fs.readFileSync(VK, 'utf8'));
      vk.vk_delta_2[0][0] = '1';
      fs.writeFileSync(forged, `${JSON.stringify(vk, null, 1)}\n`);

      // What the old check did: hash the published file, compare it with the
      // transcript field the publisher wrote from that same file.
      const transcriptField = sha256(forged);
      expect(sha256(forged)).toBe(transcriptField);

      const result = await verifyingKeyMatches(ZKEY, forged);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('is not what');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Formatting is not provenance. snarkjs writes the key one way; a publisher
  // who ran it through `jq` has not changed the key, and the check should not
  // send an auditor looking for a substitution that is not there.
  it('accepts the same key written out differently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-vk-test-'));
    const reformatted = path.join(dir, 'payment_vk.json');
    try {
      const vk = JSON.parse(fs.readFileSync(VK, 'utf8'));
      const reversed = Object.fromEntries(Object.entries(vk).reverse());
      fs.writeFileSync(reformatted, JSON.stringify(reversed, null, 4));
      expect(sha256(reformatted)).not.toBe(sha256(VK));

      const result = await verifyingKeyMatches(ZKEY, reformatted);
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('answers rather than throwing when a file is missing', async () => {
    const missingKey = await verifyingKeyMatches(path.join(BUILD, 'no-such.zkey'), VK);
    expect(missingKey.ok).toBe(false);
    expect(missingKey.reason).toContain('no key');

    const missingVk = await verifyingKeyMatches(ZKEY, path.join(BUILD, 'no-such.json'));
    expect(missingVk.ok).toBe(false);
    expect(missingVk.reason).toContain('no verifying key');
  }, 120_000);
});

describe.skipIf(HAVE_KEYS)('the verifying key is derived from the key, not from the transcript', () => {
  it('skipped: build the development key first (npm run build)', () => {
    expect(HAVE_KEYS).toBe(false);
  });
});
