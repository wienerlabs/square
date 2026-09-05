// Poseidon helpers shared by the witness builder and the rule evaluator.
//
// Ported from aperture/services/prover-service/src/hash.js. The hashing is
// unchanged — it has to stay byte-for-byte identical to the circuit and to the
// policy service's commitment, so any drift here silently invalidates every
// proof. What changed is the error messages: several of these functions used
// to embed the offending value, and they are called on private policy entries
// (blocked addresses, whitelisted mints, endpoint categories). A thrown error
// travels to the log and to the HTTP response, so a malformed blocked address
// used to leak in plaintext. Errors now name the field and never the value.

import bs58 from 'bs58';
import { buildPoseidon } from 'circomlibjs';

let poseidonInstance = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

// Poseidon over two field elements, returned as a decimal string. This is the
// shape the circuit uses for payment_token and payment_recipient, so the rule
// evaluator can reproduce list membership without a witness.
export async function poseidon2(a, b) {
  const poseidon = await getPoseidon();
  return poseidon.F.toString(poseidon([BigInt(a), BigInt(b)]));
}

// Split a 32-byte buffer into two BN254 field elements. BN254 elements are
// ~254 bits, so a 256-bit value cannot fit into a single element. Splitting
// into 16-byte halves (high || low) keeps both halves safely under the prime.
export function splitBytes(buffer) {
  if (buffer.length !== 32) {
    throw new Error(`Expected 32-byte buffer, got ${buffer.length}`);
  }
  const high = BigInt('0x' + buffer.subarray(0, 16).toString('hex'));
  const low = BigInt('0x' + buffer.subarray(16, 32).toString('hex'));
  return [high, low];
}

// Decode a base58-encoded 32-byte address into a raw Buffer.
//
// `label` names the field being decoded so a failure is diagnosable. The value
// itself never reaches the message: this is called on token_whitelist and
// blocked_addresses entries, which are private policy.
export function decodeAddress32(base58String, label = 'address') {
  let raw;
  try {
    raw = Buffer.from(bs58.decode(base58String));
  } catch {
    throw new Error(`${label}: not valid base58`);
  }
  if (raw.length !== 32) {
    throw new Error(`${label}: must decode to 32 bytes, got ${raw.length}`);
  }
  return raw;
}

// Poseidon-hash a base58 pubkey into a single BN254 field. Used for
// list-membership entries (token_whitelist[i], blocked_addresses[i]) and for
// the operator_id_field input the circuit folds into policy_data_hash.
export async function hashAddress(base58String, label = 'address') {
  const raw = decodeAddress32(base58String, label);
  const [high, low] = splitBytes(raw);
  return poseidon2(high, low);
}

// Poseidon-hash an ASCII category string. Categories are short so we right-pad
// to 32 bytes before splitting. The category is private policy, so an
// over-length one is reported by field name only.
export async function hashCategory(categoryString, label = 'category') {
  const utf8 = Buffer.from(categoryString, 'utf8');
  if (utf8.length > 32) {
    throw new Error(`${label}: exceeds the 32-byte limit`);
  }
  const padded = Buffer.alloc(32);
  utf8.copy(padded);
  const [high, low] = splitBytes(padded);
  return poseidon2(high, low);
}

// Poseidon-hash a UUID v4 string into a single field. The UUID is 16 raw
// bytes; we pad to 32 (high half = uuid bytes, low half = zeros) before
// splitting so the circuit sees the same shape any other 32-byte value uses.
export async function hashUuid(uuidString, label = 'policy_id') {
  const cleaned = String(uuidString).replace(/-/g, '');
  if (cleaned.length !== 32 || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`${label}: not a valid UUID`);
  }
  const raw16 = Buffer.from(cleaned, 'hex');
  const padded = Buffer.alloc(32);
  raw16.copy(padded, 0);
  const [high, low] = splitBytes(padded);
  return poseidon2(high, low);
}

// Pad a string list to `maxLength` by hashing each entry and zero-padding the
// tail. Returns both the hashed array and a matching mask array (1 for active
// slots, 0 for padding).
//
// The overflow message reports the ceiling but not how many entries were
// supplied: list cardinality is part of the policy the circuit exists to hide.
async function padList(values, maxLength, hasher, label) {
  if (values.length > maxLength) {
    throw new Error(`${label}: exceeds the circuit maximum of ${maxLength} entries`);
  }
  const hashed = [];
  const mask = [];
  for (const value of values) {
    hashed.push(await hasher(value, label));
    mask.push('1');
  }
  while (hashed.length < maxLength) {
    hashed.push('0');
    mask.push('0');
  }
  return { values: hashed, mask };
}

export async function padAddressList(addresses, maxLength, label) {
  return padList(addresses, maxLength, hashAddress, label);
}

export async function padCategoryList(categories, maxLength, label) {
  return padList(categories, maxLength, hashCategory, label);
}

// Map a list of weekday names ("monday".."sunday") to the 7-bit mask the
// circuit consumes. Throws on unknown names so the prover never silently
// downgrades a restriction. The name is not echoed: the configured days are
// part of the private time restriction.
const DAY_INDEX = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export function daysToBitmask(days) {
  let mask = 0;
  for (const d of days) {
    const idx = DAY_INDEX[String(d).toLowerCase()];
    if (idx === undefined) {
      throw new Error('time_restrictions.allowed_days: contains an unknown weekday name');
    }
    mask |= 1 << idx;
  }
  return mask;
}
