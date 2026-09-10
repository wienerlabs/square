// The policy commitment, and opening it one field at a time.
//
// square#45. The commitment the registry holds and the hook compares is public
// signal 1 of the proof, and until now it was Poseidon over eight policy values
// directly. That is a fine commitment and a useless one to open: an auditor
// shown seven of the eight to prove the eighth would have been shown seven
// values, and shown them as hashes it could brute-force anyway — max_daily is
// published on chain as PolicyRegistry.dailyLimit, the time field has fewer than
// 150,000 possible values, and an empty list has a well-known image. That second
// half is square#98.
//
// So each field now sits behind its own salt, and its position goes into the
// hash with it:
//
//   leaf[i] = Poseidon(3)(i, salt[i], value[i])
//   root    = Poseidon(8)(leaf[0] … leaf[7])
//
// The root is still one Poseidon(8), so the registry, the verifier and the
// public signal layout are untouched. What is new is that `open()` produces a
// disclosure an auditor can check against the chain without learning the other
// seven values.
//
// This module is the only place the construction exists on the JS side, and
// circuits/payment.circom is the only place it exists in constraints. They have
// to agree byte for byte, and circuits/test/payment.test.js is what holds them
// to it.

import crypto from 'node:crypto';
import { buildPoseidon } from 'circomlibjs';

// The committed fields, in the order the circuit hashes them. The order is part
// of the commitment — index i is an input to leaf i — so this array is not a
// convenience, it is the specification.
export const POLICY_FIELDS = Object.freeze([
  'max_daily',
  'max_per_tx',
  'operator_id',
  'policy_id',
  'allowed_categories',
  'blocked_addresses',
  'token_whitelist',
  'time_window',
]);

export const FIELD_COUNT = POLICY_FIELDS.length;

// BN254's scalar field. A salt is reduced into it, because a value that does not
// fit is not a field element and the circuit would reject the witness.
const R = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

let poseidonPromise = null;
async function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

const toField = (value) => BigInt(value);

/**
 * The eight leaf salts, derived from one secret the operator keeps with the
 * policy.
 *
 * Deriving rather than storing eight is not a shortcut: a policy has to produce
 * the same commitment every time it is proved, so the salts have to be stable,
 * and one secret is one thing to store and to lose. The derivation is inside
 * Poseidon so a disclosed leaf salt says nothing about the others — an auditor
 * given salt[3] cannot compute salt[4], which matters because a disclosure hands
 * one salt over by design.
 */
export async function deriveSalts(policySalt) {
  const poseidon = await getPoseidon();
  const secret = toField(policySalt) % R;
  const salts = [];
  for (let i = 0; i < FIELD_COUNT; i++) {
    salts.push(BigInt(poseidon.F.toString(poseidon([secret, BigInt(i)]))));
  }
  return salts;
}

/** A fresh policy salt. 32 bytes, reduced into the scalar field. */
export function randomPolicySalt() {
  return (BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) % R).toString();
}

/** leaf[i] = Poseidon(3)(i, salt, value) */
export async function leafHash(index, salt, value) {
  const poseidon = await getPoseidon();
  return BigInt(poseidon.F.toString(
    poseidon([BigInt(index), toField(salt) % R, toField(value)]),
  ));
}

/**
 * The eight leaves and the root, from the eight committed values and their
 * salts. The root is `policy_data_hash`.
 */
export async function buildCommitment(values, salts) {
  if (values.length !== FIELD_COUNT) {
    throw new Error(`expected ${FIELD_COUNT} policy values, got ${values.length}`);
  }
  if (salts.length !== FIELD_COUNT) {
    throw new Error(`expected ${FIELD_COUNT} salts, got ${salts.length}`);
  }
  const poseidon = await getPoseidon();
  const leaves = [];
  for (let i = 0; i < FIELD_COUNT; i++) {
    leaves.push(await leafHash(i, salts[i], values[i]));
  }
  const root = BigInt(poseidon.F.toString(poseidon(leaves)));
  return { root: root.toString(), leaves: leaves.map(String) };
}

/**
 * A disclosure of one field.
 *
 * What it contains is what a verifier needs and nothing else: which field, its
 * value, its salt, and the seven sibling leaves as hashes. The siblings are what
 * make it checkable and the salts are what keep them opaque.
 */
export async function open(values, salts, field) {
  const index = typeof field === 'number' ? field : POLICY_FIELDS.indexOf(field);
  if (index < 0 || index >= FIELD_COUNT) {
    throw new Error(`unknown policy field: ${field}`);
  }
  const { root, leaves } = await buildCommitment(values, salts);
  const siblings = leaves.map((leaf, i) => (i === index ? null : leaf));
  return {
    field: POLICY_FIELDS[index],
    index,
    value: String(values[index]),
    salt: String(salts[index]),
    siblings,
    root,
  };
}

/**
 * Check a disclosure against a commitment the chain holds.
 *
 * `expectedRoot` is `PolicyRegistry.commitmentOf(poster)`, so a disclosure that
 * verifies is a statement about the policy that institution registered — not
 * about a policy the discloser made up for the occasion.
 */
export async function verifyDisclosure(disclosure, expectedRoot) {
  const { index, value, salt, siblings } = disclosure;
  if (!Number.isInteger(index) || index < 0 || index >= FIELD_COUNT) {
    return { ok: false, reason: 'index out of range' };
  }
  if (!Array.isArray(siblings) || siblings.length !== FIELD_COUNT) {
    return { ok: false, reason: `expected ${FIELD_COUNT} sibling slots` };
  }
  if (siblings[index] !== null && siblings[index] !== undefined) {
    return { ok: false, reason: 'the disclosed slot must be empty, not pre-filled' };
  }
  for (let i = 0; i < FIELD_COUNT; i++) {
    if (i !== index && (siblings[i] === null || siblings[i] === undefined)) {
      return { ok: false, reason: `sibling ${i} is missing` };
    }
  }

  const poseidon = await getPoseidon();
  const recomputed = await leafHash(index, salt, value);
  const leaves = siblings.map((s, i) => (i === index ? recomputed : BigInt(s)));
  const root = BigInt(poseidon.F.toString(poseidon(leaves))).toString();

  if (root !== String(expectedRoot)) {
    return { ok: false, reason: 'the disclosure does not open the expected commitment' };
  }
  return { ok: true, field: POLICY_FIELDS[index], value: String(value) };
}
