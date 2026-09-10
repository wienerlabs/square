// Build witness inputs for payment.circom.
//
// Kept beside the tests rather than in the prover service on purpose: the
// circuit is the source of truth for its own input shape, and #18 ports the
// service to match it. Anything here that the service also has to do —
// category hashing, the policy commitment layout — is the part that must agree
// byte for byte.

import { buildPoseidon } from 'circomlibjs';

let poseidon = null;
export async function getPoseidon() {
  if (!poseidon) poseidon = await buildPoseidon();
  return poseidon;
}

// An EVM address is 20 bytes, so it fits in one BN254 element as-is. This is
// the change that took the public signals from ten to eight: the Solana version
// had to split 32-byte pubkeys into high and low halves.
export function addressToField(address) {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`not a 20-byte hex address: ${address}`);
  }
  return BigInt(`0x${hex}`).toString();
}

// Categories are short strings and 32 bytes does not fit in one field element,
// so they stay Poseidon images of the two halves — the same shape the policy
// service uses.
export async function hashCategory(category) {
  const utf8 = Buffer.from(category, 'utf8');
  if (utf8.length > 32) throw new Error(`category exceeds 32 bytes: ${category}`);
  const padded = Buffer.alloc(32);
  utf8.copy(padded);
  const high = BigInt(`0x${padded.subarray(0, 16).toString('hex')}`);
  const low = BigInt(`0x${padded.subarray(16, 32).toString('hex')}`);
  const p = await getPoseidon();
  return p.F.toString(p([high, low]));
}

// Zero-pad a list to the circuit's fixed size. There is no parallel mask any
// more: the circuit constrains the three lookup keys non-zero, so a padding
// slot cannot match, and an uncommitted mask array was a way to switch rule 4
// off without changing the policy commitment.
function pad(values, max) {
  if (values.length > max) {
    throw new Error(`list of ${values.length} exceeds the circuit maximum of ${max}`);
  }
  const out = [...values.map(String)];
  while (out.length < max) out.push('0');
  return out;
}

export const MAX_WHITELIST = 10;
export const MAX_BLOCKED = 10;
export const MAX_CATEGORIES = 8;

// 2026-09-02T13:45:30Z, a Wednesday. Mon=0, so day_of_week 2, hour 13.
export const TIMESTAMP = 1788356730;

export const ADDRESSES = {
  usdc: '0x3600000000000000000000000000000000000000',
  otherToken: '0x00000000000000000000000000000000000000ff',
  provider: '0x1111111111111111111111111111111111111111',
  blocked: '0x2222222222222222222222222222222222222222',
  operator: '0x3333333333333333333333333333333333333333',
};

// A policy that the default payment satisfies. Override pieces per test.
// Eight fixed salts. Real policies use commitment.js's randomPolicySalt; these
// are constants so a rebuilt input produces the same commitment and a failing
// test is reproducible. They are not secret and are not meant to be.
export const DEFAULT_SALTS = Object.freeze([
  '1000000000000000000000000000000000000000000000000000000000000001',
  '1000000000000000000000000000000000000000000000000000000000000002',
  '1000000000000000000000000000000000000000000000000000000000000003',
  '1000000000000000000000000000000000000000000000000000000000000004',
  '1000000000000000000000000000000000000000000000000000000000000005',
  '1000000000000000000000000000000000000000000000000000000000000006',
  '1000000000000000000000000000000000000000000000000000000000000007',
  '1000000000000000000000000000000000000000000000000000000000000008',
]);

export async function buildInput(overrides = {}) {
  const {
    maxPerTx = '10000000',            // 10 USDC at 6 decimals
    maxDaily = '100000000',           // 100 USDC
    tokenWhitelist = [ADDRESSES.usdc],
    blockedAddresses = [ADDRESSES.blocked],
    allowedCategories = ['api-call'],
    paymentCategory = 'api-call',
    operator = ADDRESSES.operator,
    policyIdField = '424242',
    policySalts = DEFAULT_SALTS,
    timeActive = '0',
    timeDaysBitmask = '0',
    timeStartHourUtc = '0',
    timeEndHourUtc = '0',
    recipient = ADDRESSES.provider,
    amount = '5000000',               // 5 USDC
    token = ADDRESSES.usdc,
    dailySpentBefore = '50000000',    // 50 USDC
    timestamp = TIMESTAMP,
    stripeReceiptHash = '0',
  } = overrides;

  const tokens = pad(tokenWhitelist.map(addressToField), MAX_WHITELIST);
  const blocked = pad(blockedAddresses.map(addressToField), MAX_BLOCKED);
  const categories = pad(
    await Promise.all(allowedCategories.map(hashCategory)),
    MAX_CATEGORIES,
  );

  return {
    max_per_tx: String(maxPerTx),
    max_daily: String(maxDaily),
    token_whitelist: tokens,
    blocked_addresses: blocked,
    allowed_categories: categories,
    payment_category: await hashCategory(paymentCategory),
    operator_id_field: addressToField(operator),
    policy_id_field: String(policyIdField),
    // Fixed rather than random, so a rebuilt input produces the same
    // commitment and a failing test is reproducible. A real policy uses
    // commitment.js's randomPolicySalt.
    policy_salts: policySalts,
    time_active: String(timeActive),
    time_days_bitmask: String(timeDaysBitmask),
    time_start_hour_utc: String(timeStartHourUtc),
    time_end_hour_utc: String(timeEndHourUtc),
    recipient_in: addressToField(recipient),
    amount_in: String(amount),
    token_in: addressToField(token),
    daily_spent_before_in: String(dailySpentBefore),
    current_unix_timestamp_in: String(timestamp),
    stripe_receipt_hash_in: String(stripeReceiptHash),
  };
}

// The public signals, in the order payment.circom declares them. The verifier
// reads them positionally, so this order is part of the contract between the
// circuit, the prover service and the on-chain verifier.
export const PUBLIC_SIGNALS = [
  'is_compliant',
  'policy_data_hash',
  'recipient',
  'amount',
  'token',
  'daily_spent_before',
  'current_unix_timestamp',
  'stripe_receipt_hash',
];

// Recompute the policy commitment outside the circuit. #18 ports this into the
// prover service and #45 into the policy service; if either drifts from this,
// every proof it produces is bound to the wrong policy.
export async function policyDataHash(input) {
  const p = await getPoseidon();
  const f = (x) => p.F.toString(x);
  const catHash = p(input.allowed_categories.map(BigInt));
  const blockedHash = p(input.blocked_addresses.map(BigInt));
  const tokensHash = p(input.token_whitelist.map(BigInt));

  const timeField = BigInt(input.time_active) === 0n
    ? '0'
    : f(p([
      BigInt(input.time_active),
      BigInt(input.time_days_bitmask),
      BigInt(input.time_start_hour_utc),
      BigInt(input.time_end_hour_utc),
    ]));

  // square#45: eight salted, position-separated leaves, and the root is the
  // commitment. This is a third independent implementation of the construction
  // — the circuit is the first and services/prover/src/commitment.js the second
  // — and the point of writing it out longhand here rather than importing one
  // of the others is that a test which shares an implementation with the thing
  // it is testing proves only that the code equals itself.
  const values = [
    BigInt(input.max_daily),
    BigInt(input.max_per_tx),
    BigInt(input.operator_id_field),
    BigInt(input.policy_id_field),
    BigInt(f(catHash)),
    BigInt(f(blockedHash)),
    BigInt(f(tokensHash)),
    BigInt(timeField),
  ];
  const leaves = values.map((value, i) => BigInt(f(p([
    BigInt(i), BigInt(input.policy_salts[i]), value,
  ]))));
  return f(p(leaves));
}
