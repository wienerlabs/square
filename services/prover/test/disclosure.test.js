// Opening the policy commitment one field at a time.
//
// square#45. The three things this has to establish are the issue's acceptance
// criteria, and the third is the one that makes the other two worth anything:
// the root a disclosure opens is the value the chain holds, so a disclosure that
// verifies is a statement about the policy that institution registered — not
// about a policy the discloser assembled for the occasion.
//
// The salt is what makes the first two compatible. Without it a "selective"
// disclosure discloses everything, and the last test in this file demonstrates
// that rather than asserting it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoseidon } from 'circomlibjs';
import {
  POLICY_FIELDS, FIELD_COUNT, buildCommitment, deriveSalts, leafHash,
  open, verifyDisclosure, randomPolicySalt,
} from '../src/commitment.js';
import { buildCircuitInput, generateProof } from '../src/prover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.join(HERE, '..', 'artifacts');
const HAVE_ARTIFACTS = fs.existsSync(path.join(ARTIFACTS, 'payment.wasm'))
  && fs.existsSync(path.join(ARTIFACTS, 'payment.zkey'));

const USDC = '0x3600000000000000000000000000000000000000';
const POLICY_SALT = '7777777777777777777777777777777777777777777777777777777777777';

const REQUEST = Object.freeze({
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  policy_salt: POLICY_SALT,
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: ['0x2222222222222222222222222222222222222222'],
  token_whitelist: [USDC],
  payment_token: USDC,
  payment_recipient: '0x1111111111111111111111111111111111111111',
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
});

// The eight committed values, in the order the circuit hashes them, derived from
// the same request the prover would use.
async function committedValues(overrides = {}) {
  const poseidon = await buildPoseidon();
  const f = (x) => poseidon.F.toString(x);
  const input = await buildCircuitInput({ ...REQUEST, ...overrides });
  const timeField = BigInt(input.time_active) === 0n
    ? '0'
    : f(poseidon([
      BigInt(input.time_active), BigInt(input.time_days_bitmask),
      BigInt(input.time_start_hour_utc), BigInt(input.time_end_hour_utc),
    ]));
  return [
    input.max_daily,
    input.max_per_tx,
    input.operator_id_field,
    input.policy_id_field,
    f(poseidon(input.allowed_categories.map(BigInt))),
    f(poseidon(input.blocked_addresses.map(BigInt))),
    f(poseidon(input.token_whitelist.map(BigInt))),
    timeField,
  ];
}

const salts = () => deriveSalts(POLICY_SALT);

describe('a disclosure of one field', () => {
  it.each(POLICY_FIELDS)('opens %s and verifies against the root', async (field) => {
    const values = await committedValues();
    const s = await salts();
    const { root } = await buildCommitment(values, s);

    const disclosure = await open(values, s, field);
    const result = await verifyDisclosure(disclosure, root);

    expect(result.ok).toBe(true);
    expect(result.field).toBe(field);
    expect(result.value).toBe(String(values[POLICY_FIELDS.indexOf(field)]));
  });

  it('carries the disclosed field and nothing else in the clear', async () => {
    const values = await committedValues();
    const s = await salts();
    const disclosure = await open(values, s, 'max_per_tx');

    // Set membership, not substring search: one of the committed values is the
    // string '0' — a policy with no time window — and searching for it inside
    // serialised JSON matches every field that happens to contain a zero. The
    // question is which values the disclosure *carries*, so ask that.
    const carried = new Set([
      String(disclosure.value),
      String(disclosure.salt),
      ...disclosure.siblings.filter((x) => x !== null).map(String),
    ]);

    // The disclosed value and its salt are there, by design.
    expect(carried.has(String(values[1]))).toBe(true);
    expect(carried.has(String(s[1]))).toBe(true);

    // None of the other seven values is, and neither is any other salt. The
    // siblings are leaf hashes, so they are in the set — but a leaf hash is not
    // the value, which is the whole point, and the salt is what stops it being
    // recoverable from one. The last describe in this file demonstrates that.
    for (let i = 0; i < FIELD_COUNT; i++) {
      if (i === 1) continue;
      expect(carried.has(String(values[i]))).toBe(false);
      expect(carried.has(String(s[i]))).toBe(false);
    }
  });

  it('leaves exactly one slot open, and the verifier insists on it', async () => {
    const values = await committedValues();
    const s = await salts();
    const { root } = await buildCommitment(values, s);
    const disclosure = await open(values, s, 'time_window');

    expect(disclosure.siblings[7]).toBeNull();
    expect(disclosure.siblings.filter((x) => x === null)).toHaveLength(1);

    // A pre-filled slot would let a discloser present a leaf it never opened.
    const prefilled = {
      ...disclosure,
      siblings: disclosure.siblings.map((x, i) => (i === 7 ? '1' : x)),
    };
    const result = await verifyDisclosure(prefilled, root);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/must be empty/);
  });
});

describe('a disclosure that is not what it claims', () => {
  const cases = [
    ['a changed value', (d) => ({ ...d, value: '999' })],
    ['a changed salt', (d) => ({ ...d, salt: '1' })],
    ['a different index', (d) => ({ ...d, index: 2 })],
    ['a swapped sibling', (d) => ({
      ...d, siblings: d.siblings.map((x, i) => (i === 3 ? d.siblings[4] : x)),
    })],
  ];

  it.each(cases)('is rejected: %s', async (_name, mutate) => {
    const values = await committedValues();
    const s = await salts();
    const { root } = await buildCommitment(values, s);
    const disclosure = await open(values, s, 'max_daily');

    const result = await verifyDisclosure(mutate(disclosure), root);
    expect(result.ok).toBe(false);
  });

  it('is rejected against a different policy\'s root', async () => {
    const values = await committedValues();
    const s = await salts();
    const disclosure = await open(values, s, 'max_daily');

    const otherValues = await committedValues({ max_daily_spend: '999000000' });
    const { root: otherRoot } = await buildCommitment(otherValues, s);

    const result = await verifyDisclosure(disclosure, otherRoot);
    expect(result.ok).toBe(false);
  });

  // The position is inside the leaf, so a leaf cannot be replayed elsewhere.
  // Aperture's tree sorted each pair before hashing, which throws that away.
  it('cannot move a leaf to another position', async () => {
    const s = await salts();
    const atThree = await leafHash(3, s[3], '42');
    const atFour = await leafHash(4, s[3], '42');
    expect(atThree).not.toBe(atFour);
  });
});

// Criterion 3, and the one that makes this a commitment rather than a
// bookkeeping exercise: the root is public signal 1 of a real proof, which is
// the value PolicyRegistry.commitmentOf holds and the hook compares.
describe.skipIf(!HAVE_ARTIFACTS)('the root is the on-chain commitment', () => {
  it('equals the policy_data_hash a real proof carries', async () => {
    const values = await committedValues();
    const s = await salts();
    const { root } = await buildCommitment(values, s);

    const proof = await generateProof(REQUEST);

    expect(proof.public_signals.policy_data_hash).toBe(root);
    // And the eight signals the verifier reads, in order, carry it at index 1.
    expect(proof.solidity.input[1]).toBe(
      `0x${BigInt(root).toString(16).padStart(64, '0')}`,
    );
  }, 60_000);

  it('lets a disclosure be checked against what the chain would hold', async () => {
    const values = await committedValues();
    const s = await salts();
    const proof = await generateProof(REQUEST);
    const onChain = proof.public_signals.policy_data_hash;

    const disclosure = await open(values, s, 'max_per_tx');
    const result = await verifyDisclosure(disclosure, onChain);

    expect(result.ok).toBe(true);
    expect(result.value).toBe('10000000');
  }, 60_000);
});

describe.skipIf(HAVE_ARTIFACTS)('the root is the on-chain commitment', () => {
  it('skipped: no circuit artifacts present', () => {
    expect(HAVE_ARTIFACTS).toBe(false);
  });
});

// Why the salt is not decoration.
//
// max_daily is published on chain as PolicyRegistry.dailyLimit, so an auditor
// holding a sibling leaf already knows what to guess. This demonstrates the
// difference rather than asserting it: the same search that finds an unsalted
// leaf in a few thousand tries does not find a salted one.
describe('the salt is what makes a sibling opaque', () => {
  it('an unsalted leaf falls to a small search, a salted one does not', async () => {
    const poseidon = await buildPoseidon();
    const f = (x) => poseidon.F.toString(x);

    const secret = 25_000n;                       // 25,000 USDC, a plausible ceiling
    const unsalted = f(poseidon([secret]));
    const salted = await leafHash(0, (await salts())[0], secret);

    let foundUnsalted = null;
    let foundSalted = null;
    for (let guess = 24_000n; guess <= 26_000n; guess++) {
      if (f(poseidon([guess])) === unsalted) foundUnsalted = guess;
      // The attacker knows the position and the construction, and still needs
      // the salt.
      if (await leafHash(0, 0n, guess) === salted) foundSalted = guess;
    }

    expect(foundUnsalted).toBe(secret);
    expect(foundSalted).toBeNull();
  }, 120_000);

  it('gives every policy a different commitment for the same values', async () => {
    const values = await committedValues();
    const a = await buildCommitment(values, await deriveSalts(randomPolicySalt()));
    const b = await buildCommitment(values, await deriveSalts(randomPolicySalt()));
    expect(a.root).not.toBe(b.root);
  });
});
