// Off-circuit evaluation of the six policy rules in payment.circom.
//
// The circuit only exposes `is_compliant`. It never says which rule failed, so
// the service used to answer "why?" by dumping the whole request into the log —
// the operator's ceilings and lists, in plaintext, in the one place the circuit
// exists to keep them out of. This module replaces that: it recomputes the same
// six predicates from the same witness the circuit consumes and reports the
// *names* of the rules that failed. A name is safe to log; a ceiling is not.
//
// It operates on the circuit input object, not the HTTP request, deliberately.
// The lists arrive already Poseidon-hashed and mask-padded, exactly as the
// circuit sees them, so membership here cannot disagree with membership there
// by reading a different field or applying a different encoding.
//
// Where this can still differ from the circuit, and why it does not matter in
// practice:
//
//   * Rules 1 and 2 use LessEqThan(64) and LessEqThan(65) in circom, which are
//     only meaningful for inputs below 2^64 and 2^65. This module compares
//     exact BigInts. For in-range amounts the two agree; out-of-range amounts
//     are the range question #14 settles by pinning escrow to the 6-decimal
//     USDC ERC-20 interface.
//   * Rule 6's in-circuit timestamp decomposition is under-constrained (#14):
//     a dishonest prover can witness a day index of their choosing. This module
//     computes the decomposition honestly, so it agrees with the circuit for
//     honest provers and is *stricter* than it for dishonest ones. #14 removes
//     the rule from the circuit and moves the check to block.timestamp on
//     chain; when that lands, TIME_WINDOW comes out of this file too.
//
// Any disagreement between this module and the circuit is reported by the
// caller as a divergence rather than hidden — see prover.js.

import { poseidon2 } from './hash.js';

export const RULES = Object.freeze({
  PER_TRANSACTION_LIMIT: 'per_transaction_limit',
  DAILY_LIMIT: 'daily_limit',
  TOKEN_WHITELIST: 'token_whitelist',
  BLOCKED_RECIPIENT: 'blocked_recipient',
  ENDPOINT_CATEGORY: 'endpoint_category',
  TIME_WINDOW: 'time_window',
});

// Every rule name this module can emit. The logging layer uses it to prove no
// other string can reach a log line.
export const RULE_NAMES = Object.freeze(Object.values(RULES));

const SECONDS_PER_DAY = 86400n;
const SECONDS_PER_HOUR = 3600n;

// 1970-01-01 was a Thursday. The dashboard's weekday constants are Mon=0..Sun=6,
// which puts Thursday at 3, hence the +3 shift. Same constant as the circuit.
const EPOCH_WEEKDAY_OFFSET = 3n;

// Membership over the mask-padded lists, matching the circuit's
// IsEqual + mask + OR-fold. Padding slots carry mask 0 and are ignored, so a
// zero-valued entry can never be matched by accident.
function isInMaskedList(needle, values, mask) {
  for (let i = 0; i < values.length; i += 1) {
    if (BigInt(mask[i]) === 1n && BigInt(values[i]) === needle) return true;
  }
  return false;
}

// Rule 6, mirroring the circuit's decomposition step for step.
function timeWindowSatisfied(input) {
  if (BigInt(input.time_active) === 0n) return true;

  const timestamp = BigInt(input.current_unix_timestamp_in);
  const dayIndex = timestamp / SECONDS_PER_DAY;
  const secondsInDay = timestamp % SECONDS_PER_DAY;
  const hour = secondsInDay / SECONDS_PER_HOUR;
  const dayOfWeek = (dayIndex + EPOCH_WEEKDAY_OFFSET) % 7n;

  const bitmask = BigInt(input.time_days_bitmask);
  const dayActive = ((bitmask >> dayOfWeek) & 1n) === 1n;

  const startHour = BigInt(input.time_start_hour_utc);
  const endHour = BigInt(input.time_end_hour_utc);
  // The circuit assumes start <= end; windows spanning midnight are not
  // modelled there either, so this mirrors the same limitation rather than
  // quietly being more permissive.
  const hourInWindow = hour >= startHour && hour <= endHour;

  return dayActive && hourInWindow;
}

// Evaluate all six rules against the circuit witness.
//
// Returns every rule that failed, not just the first: an operator debugging a
// rejected payment needs the whole list, and it costs nothing to compute.
export async function evaluateRules(input) {
  const violated = [];

  const amount = BigInt(input.amount_lamports_in);
  const dailySpentBefore = BigInt(input.daily_spent_before_in);

  // Rule 1 — amount_lamports <= max_per_tx_lamports
  if (amount > BigInt(input.max_per_tx_lamports)) {
    violated.push(RULES.PER_TRANSACTION_LIMIT);
  }

  // Rule 2 — daily_spent_before + amount_lamports <= max_daily_lamports
  if (dailySpentBefore + amount > BigInt(input.max_daily_lamports)) {
    violated.push(RULES.DAILY_LIMIT);
  }

  // Rule 3 — the payment mint is on the whitelist.
  const paymentToken = BigInt(
    await poseidon2(input.token_mint_high_in, input.token_mint_low_in),
  );
  if (!isInMaskedList(paymentToken, input.token_whitelist, input.token_whitelist_mask)) {
    violated.push(RULES.TOKEN_WHITELIST);
  }

  // Rule 4 — the recipient is not on the blocked list.
  const paymentRecipient = BigInt(
    await poseidon2(input.recipient_high_in, input.recipient_low_in),
  );
  if (isInMaskedList(paymentRecipient, input.blocked_addresses, input.blocked_addresses_mask)) {
    violated.push(RULES.BLOCKED_RECIPIENT);
  }

  // Rule 5 — the endpoint category is allowed.
  const category = BigInt(input.payment_category);
  if (!isInMaskedList(category, input.allowed_categories, input.allowed_categories_mask)) {
    violated.push(RULES.ENDPOINT_CATEGORY);
  }

  // Rule 6 — the payment falls inside the configured time window.
  if (!timeWindowSatisfied(input)) {
    violated.push(RULES.TIME_WINDOW);
  }

  return { compliant: violated.length === 0, violated };
}
