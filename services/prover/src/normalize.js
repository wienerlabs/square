// Turn untrusted request values into circuit field elements, without letting
// the value escape into an error message.
//
// This exists because of a leak that is easy to miss. `BigInt("abc")` throws
// `SyntaxError: Cannot convert abc to a BigInt` — the offending value, verbatim,
// in the message. That message reaches the log and the HTTP response. Since the
// values being converted include `max_daily_spend_lamports` and
// `max_per_transaction_lamports`, a malformed ceiling used to print itself into
// the log the same way the violation path printed the whole body.
//
// Normalising every numeric field here, before it reaches BigInt or snarkjs,
// closes that path: conversion failures are reported by field name only. It
// also means the top-level error handler can log an unrecognised error's
// message without auditing every library we call, because no policy value can
// still be inside one by the time it gets there.

// BN254 scalar field modulus. Every circuit signal must be below it; snarkjs
// would otherwise reduce or reject the value further down the stack, where the
// error is less specific and not under our control.
const BN254_R = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

// A non-negative integer, as the decimal string the circuit input expects.
//
// Accepts a string, a JS number that is a safe integer, or a bigint. Rejects
// everything else by field name. Floats are rejected rather than truncated: a
// silently rounded ceiling is a policy change, not a formatting detail.
export function toFieldString(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`${label}: missing`);
  }

  let text;
  if (typeof value === 'bigint') {
    text = value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`${label}: must be a whole number`);
    }
    if (!Number.isSafeInteger(value)) {
      // Beyond 2^53 a JSON number has already lost precision before we saw it.
      throw new Error(`${label}: exceeds the safe integer range, send it as a string`);
    }
    text = value.toString();
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new Error(`${label}: must be a string or a number`);
  }

  if (!INTEGER_PATTERN.test(text)) {
    throw new Error(`${label}: must be a non-negative integer`);
  }

  if (BigInt(text) >= BN254_R) {
    throw new Error(`${label}: does not fit in the BN254 scalar field`);
  }

  return text;
}

// The operator's policy secret, as the decimal string the circuit input expects.
//
// Everything the commitment hides rests on this one value: the eight leaf salts
// derive from it, so a caller who can guess it can derive them all and open any
// leaf by trying values against it. Two of the eight are round USDC ceilings, so
// the dictionary is small. Measured on the values the service used to accept
// (square#178), recovering a 25 USDC per-transaction ceiling:
//
//   policy_salt "0"          50 tries, 10 ms
//   the schema's own example 24 050 tries, 3.5 s
//   a random salt            not found in 32 000 tries
//
// The floor is 2^128. It is a magnitude check and not an entropy check, and the
// difference matters: it rejects 0, 1 and every small constant, and it passes
// every value randomPolicySalt() can produce -- a 32-byte draw lands below 2^128
// with probability about 2^-126 -- but it cannot tell a random 200-bit number
// from one somebody typed. That part is the caller's, and openapi.js says so
// where the caller will read it.
export const MIN_POLICY_SALT = 1n << 128n;

export function toPolicySaltString(value, label) {
  const text = toFieldString(value, label);
  if (BigInt(text) < MIN_POLICY_SALT) {
    throw new Error(
      `${label}: must be at least 2^128. It is the secret every leaf salt derives `
      + 'from, so a guessable one opens the committed policy; draw 32 random bytes '
      + 'and reduce them into the field.',
    );
  }
  return text;
}

// An hour of the day, as the decimal string the circuit input expects.
//
// The bound is here rather than at the three places that had one. Before
// square#148 an hour had three different upper limits and no two agreed:
// openapi.js declared 0..23 and enforced nothing, the circuit's Num2Bits(5)
// allowed 0..31, and toFieldString above allowed everything under the BN254
// modulus. The gap between the first two is silent -- an hour of 25 empties the
// window and every payment is refused with no diagnosis -- and the gap between
// the second two fails inside witness generation, where the caller gets a
// constraint error instead of the name of the field they got wrong.
//
// 0..23 is the range openapi.js already published, so this enforces a contract
// rather than inventing one.
export function toHourString(value, label) {
  const text = toFieldString(value, label);
  if (BigInt(text) > 23n) {
    throw new Error(`${label}: must be an hour of the day, 0 to 23`);
  }
  return text;
}

// A plain string field (an identifier, not a policy value). Length-capped so a
// caller cannot push an arbitrarily large blob into a log line through a field
// the logger is allowed to emit.
export function toIdentifier(value, label, maxLength = 128) {
  if (typeof value !== 'string') {
    throw new Error(`${label}: must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label}: must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label}: exceeds ${maxLength} characters`);
  }
  return trimmed;
}
