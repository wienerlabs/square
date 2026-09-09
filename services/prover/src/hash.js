// Encoding and Poseidon helpers shared by the witness builder and the rule
// evaluator.
//
// These have to agree with circuits/payment.circom byte for byte. The circuit
// is the source of truth for its own input shape; circuits/test/helpers/
// inputs.mjs is the reference implementation, and prover.test.js checks this
// file against the compiled circuit rather than against that reference, so a
// drift in either is caught.
//
// What changed for EVM (#14, #18): a 20-byte address fits in one BN254 field
// element, so the Solana high/low split is gone, and so is the Poseidon hash
// that used to fold the two halves into one comparable value. Address list
// entries are now raw field elements and membership is plain equality.
// Categories are still hashed — they are strings, and 32 bytes does not fit.
//
// Error messages name the field and never the value. Several of these run on
// private policy entries, and an error travels to the log and the HTTP
// response; see #4.

import { buildPoseidon } from 'circomlibjs';

let poseidonInstance = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

// Poseidon over a list of field elements, as a decimal string.
export async function poseidon(inputs) {
  const p = await getPoseidon();
  return p.F.toString(p(inputs.map((x) => BigInt(x))));
}

// A 20-byte EVM address as a field element.
//
// Checksums are not validated: the contract binds this value to an address it
// already knows, so a wrong-but-well-formed address fails there rather than
// here, and rejecting a lowercase address would only break callers.
export function addressToField(address, label = 'address') {
  if (typeof address !== 'string') {
    throw new Error(`${label}: must be a string`);
  }
  const hex = address.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`${label}: must be a 20-byte hex address`);
  }
  return BigInt(`0x${hex}`).toString();
}

// Poseidon-hash an ASCII category string into a single field element.
//
// Right-padded to 32 bytes and split into halves before hashing, because 32
// bytes exceeds the field. The shape is fixed by the circuit and the policy
// service, so it cannot be simplified independently of both.
export async function hashCategory(categoryString, label = 'category') {
  if (typeof categoryString !== 'string') {
    throw new Error(`${label}: must be a string`);
  }
  const utf8 = Buffer.from(categoryString, 'utf8');
  if (utf8.length === 0) {
    throw new Error(`${label}: must not be empty`);
  }
  if (utf8.length > 32) {
    throw new Error(`${label}: exceeds the 32-byte limit`);
  }
  const padded = Buffer.alloc(32);
  utf8.copy(padded);
  const high = BigInt(`0x${padded.subarray(0, 16).toString('hex')}`);
  const low = BigInt(`0x${padded.subarray(16, 32).toString('hex')}`);
  return poseidon([high, low]);
}

// Poseidon-hash a UUID into a single field element.
//
// Policy ids are UUIDs in the policy service, and 16 bytes would fit in a field
// element directly — but the circuit folds this into policy_data_hash and both
// sides have to agree, so the shape stays as it is rather than being simplified
// on one side only.
export async function hashUuid(uuidString, label = 'policy_id') {
  if (typeof uuidString !== 'string') {
    throw new Error(`${label}: must be a string`);
  }
  const cleaned = uuidString.replace(/-/g, '');
  if (cleaned.length !== 32 || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`${label}: not a valid UUID`);
  }
  const padded = Buffer.alloc(32);
  Buffer.from(cleaned, 'hex').copy(padded, 0);
  const high = BigInt(`0x${padded.subarray(0, 16).toString('hex')}`);
  const low = BigInt(`0x${padded.subarray(16, 32).toString('hex')}`);
  return poseidon([high, low]);
}

// Zero-pad a list to the circuit's fixed size.
//
// There is no parallel mask any more. The circuit constrains the three lookup
// keys non-zero, so a padding slot can never match one — and the mask arrays it
// replaced were a hole: policy_data_hash committed to the list values but not
// to the masks, so zeroing blocked_addresses_mask switched rule 4 off while
// leaving the commitment byte-identical.
//
// The overflow message reports the ceiling but not how many entries were sent:
// list cardinality is part of the policy the circuit exists to hide.
export function assertWithinCircuitMaximum(length, maxLength, label) {
  if (length > maxLength) {
    throw new Error(`${label}: exceeds the circuit maximum of ${maxLength} entries`);
  }
}

function pad(values, maxLength, label) {
  assertWithinCircuitMaximum(values.length, maxLength, label);
  const out = values.map(String);
  while (out.length < maxLength) out.push('0');
  return out;
}

export function padAddressList(addresses, maxLength, label) {
  return pad(addresses.map((a) => addressToField(a, label)), maxLength, label);
}

export async function padCategoryList(categories, maxLength, label) {
  // Before the loop, not after it. pad() checks the same thing, but by then
  // every entry has already been Poseidon-hashed and thrown away: the body limit
  // allows roughly 65,400 single-character categories at about 100 microseconds
  // each, and `await` on an already-resolved value never yields, so the event
  // loop is blocked for the whole of it and /health stops answering.
  assertWithinCircuitMaximum(categories.length, maxLength, label);
  const hashed = [];
  for (const category of categories) {
    hashed.push(await hashCategory(category, label));
  }
  return pad(hashed, maxLength, label);
}

// Map weekday names to the 7-bit mask the circuit consumes. Throws on unknown
// names so a restriction is never silently downgraded. The name is not echoed:
// the configured days are part of the private time restriction.
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
