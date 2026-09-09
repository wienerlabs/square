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
// The lists arrive already encoded and padded exactly as the circuit sees them,
// so membership here cannot disagree with membership there by reading a
// different field or applying a different encoding.
//
// Where this can still differ from the circuit:
//
//   * Rules 1 and 2 use LessEqThan(64) and LessEqThan(65) in circom. The
//     circuit range-checks all four operands to 64 bits — the two payment
//     values, and, since square#119, the two policy ceilings — so an
//     out-of-range value fails witness generation rather than reaching either
//     comparison. For everything the circuit accepts, exact BigInt comparison
//     agrees.
//
//     The ceilings were not bounded before that, and this note claimed they
//     were. It mattered less than it reads: a comparator given an out-of-range
//     operand can only reject wrongly, so the failure was closed and no proof
//     of compliance ever came out of it. But an invariant asserted here and not
//     built in the circuit is exactly what the next reader relies on.
//   * Rule 6's decomposition is constrained in the circuit as of #14, so this
//     module and the circuit compute the same weekday for the same timestamp.
//     Before that fix a dishonest prover could choose the weekday and only this
//     module was honest about it.
//
// Any disagreement between this module and the circuit is reported by the
// caller as a divergence rather than hidden — see prover.js.

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

// Membership over the zero-padded lists, matching the circuit's IsEqual +
// OR-fold. There are no mask arrays: the circuit constrains the three lookup
// keys non-zero, so a padding slot cannot match one. A caller that reaches here
// with a zero key would have failed witness generation, but this refuses to
// answer for it rather than reporting a membership result the circuit will not
// stand behind.
function isInList(needle, values) {
  if (needle === 0n) {
    throw new Error('lookup key is zero; the circuit rejects this witness');
  }
  for (let i = 0; i < values.length; i += 1) {
    if (BigInt(values[i]) === needle) return true;
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

  const amount = BigInt(input.amount_in);
  const dailySpentBefore = BigInt(input.daily_spent_before_in);

  // Rule 1 — amount <= max_per_tx
  if (amount > BigInt(input.max_per_tx)) {
    violated.push(RULES.PER_TRANSACTION_LIMIT);
  }

  // Rule 2 — daily_spent_before + amount <= max_daily
  if (dailySpentBefore + amount > BigInt(input.max_daily)) {
    violated.push(RULES.DAILY_LIMIT);
  }

  // Rule 3 — the payment token is on the whitelist. The address is the field
  // element itself now; the Poseidon fold of high/low halves went with the
  // Solana pubkeys that needed it.
  if (!isInList(BigInt(input.token_in), input.token_whitelist)) {
    violated.push(RULES.TOKEN_WHITELIST);
  }

  // Rule 4 — the recipient is not on the blocked list.
  if (isInList(BigInt(input.recipient_in), input.blocked_addresses)) {
    violated.push(RULES.BLOCKED_RECIPIENT);
  }

  // Rule 5 — the endpoint category is allowed. Categories are strings, so this
  // one is still a Poseidon image.
  if (!isInList(BigInt(input.payment_category), input.allowed_categories)) {
    violated.push(RULES.ENDPOINT_CATEGORY);
  }

  // Rule 6 — the payment falls inside the configured time window.
  if (!timeWindowSatisfied(input)) {
    violated.push(RULES.TIME_WINDOW);
  }

  return { compliant: violated.length === 0, violated };
}
