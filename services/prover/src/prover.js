import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  assertWithinCircuitMaximum,
  padAddressList,
  padCategoryList,
  addressToField,
  hashCategory,
  hashUuid,
  daysToBitmask,
} from './hash.js';
import { deriveSalts, POLICY_FIELDS } from './commitment.js';
import { toFieldString, toHourString, toIdentifier, toPolicySaltString } from './normalize.js';
import { evaluateRules } from './rules.js';
import { encodeForSolidity } from './convert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACTS_DIR = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(__dirname, '..', 'artifacts');
const WASM_PATH = path.join(ARTIFACTS_DIR, 'payment.wasm');
const ZKEY_PATH = path.join(ARTIFACTS_DIR, 'payment.zkey');

/**
 * The files this module opens, exported so nothing else has to guess them.
 *
 * square#235: `/health` derived the same directory a second time and fell back
 * to `path.resolve('artifacts')`, which is relative to the working directory,
 * while this fallback is relative to the module. With `PROVER_ARTIFACTS_DIR`
 * set the two agree; without it they agree only when the process happens to be
 * started from `services/prover`. Measured, both ways round:
 *
 *   artifacts in the working directory, none beside the module
 *     GET  /health -> 200 healthy
 *     POST /prove  -> 500 ENOENT .../services/prover/artifacts/payment.wasm
 *
 *   artifacts beside the module, none in the working directory
 *     GET  /health -> 503 unhealthy
 *     POST /prove  -> 200, a real proof
 *
 * The first is a container that passes its probe and fails every request; the
 * second never satisfies `depends_on: {condition: service_healthy}`. A health
 * check is only worth the path it inspects, so there is one derivation and the
 * check reads it from here.
 *
 * The fallback stays module-relative: it names the same directory wherever the
 * service is started from, which a working-directory fallback cannot.
 */
export const ARTIFACT_PATHS = Object.freeze({
  dir: ARTIFACTS_DIR,
  wasm: WASM_PATH,
  zkey: ZKEY_PATH,
});

// Fixed list sizes, matching the circuit's template parameters:
//   component main = PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES)
const MAX_WHITELIST = 10;
const MAX_BLOCKED = 10;
const MAX_CATEGORIES = 8;

// Eight public signals since #14 collapsed the Solana high/low address halves.
//
// The guard below is strict in both directions and stays that way. A circuit
// and a prover that disagree about the public layout produce proofs that verify
// against the wrong statement, which is far worse than a hard failure — the
// contract would be reading an amount out of a slot that holds a timestamp.
const EXPECTED_PUBLIC_SIGNALS = 8;

const PUBLIC_SIGNAL_ORDER = [
  'is_compliant',
  'policy_data_hash',
  'recipient',
  'amount',
  'token',
  'daily_spent_before',
  'current_unix_timestamp',
  'stripe_receipt_hash',
];

// Validate that an incoming request carries every field the circuit needs.
// Field names only — never their values (#4).
// Exported so the route can run it as a gate and answer 400.
//
// It is the one function in this file whose failures are all the caller's: every
// throw below names a field the request supplied. buildCircuitInput calls it too,
// so a direct caller -- the end-to-end script, the tests -- gets the same checks
// without going through HTTP.
export function validateRequest(req) {
  const required = [
    'policy_id',
    'operator_id',
    'max_daily_spend',
    'max_per_transaction',
    'allowed_endpoint_categories',
    'blocked_addresses',
    'token_whitelist',
    'payment_amount',
    'payment_token',
    'payment_recipient',
    'payment_endpoint_category',
    'daily_spent_before',
    'current_unix_timestamp',
    // square#45: the secret the eight leaf salts are derived from. Required,
    // not generated here — a policy has to produce the same commitment every
    // time it is proved, and a salt this service invented would change the
    // commitment on every call and never match the one on chain.
    'policy_salt',
    // stripe_receipt_hash is OPTIONAL and defaults to '0'.
  ];
  // Absence before malformation, and the order is deliberate.
  //
  // A field that is not there cannot be format-checked, so every check below
  // would need a null guard if this ran second. And this one reports *all* the
  // missing fields at once, which a caller can act on in a single round trip;
  // the format checks report the first problem they meet.
  //
  // The consequence is that a request missing one field and malforming another
  // hears about the missing one only. That is the right trade, but it is not
  // free: it means any test asserting on a specific format message is also
  // asserting that nothing is missing. `test/validation.test.js` pins this
  // ordering directly so the dependency is stated rather than discovered when
  // an unrelated required field is added — which is exactly what square#45 did
  // to square#119's tests by making policy_salt required.
  const missing = required.filter((k) => req[k] === undefined || req[k] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  }

  // The policy secret, before anything derives from it. square#178: it was on
  // the required list and nothing else, so "0" and "1" were accepted and the
  // eight leaf salts became constants anybody can compute.
  toPolicySaltString(req.policy_salt, 'policy_salt');

  for (const key of ['allowed_endpoint_categories', 'blocked_addresses', 'token_whitelist']) {
    if (!Array.isArray(req[key])) {
      throw new Error(`${key}: must be an array`);
    }
  }

  // The list lengths, before anything hashes them.
  //
  // padCategoryList used to Poseidon-hash every entry and only then discover the
  // list was too long. The cap is 8 and the only other limit is the 256 kb body,
  // which holds roughly 65,400 single-character categories at ~100 microseconds
  // each — about six seconds of hashing on a fast machine, longer on a small
  // vCPU, all of it thrown away by the length check that follows. It also blocks
  // the event loop outright: `await` on an already-resolved value queues a
  // microtask, and Node drains the microtask queue before returning to the loop,
  // so /health and /metrics stop answering for the duration.
  //
  // Checking here costs one comparison and makes the work impossible to start.
  // The message deliberately does not echo how many were sent.
  for (const [key, max] of [
    ['allowed_endpoint_categories', MAX_CATEGORIES],
    ['blocked_addresses', MAX_BLOCKED],
    ['token_whitelist', MAX_WHITELIST],
  ]) {
    assertWithinCircuitMaximum(req[key].length, max, key);
  }

  // time_restrictions gets the same treatment as the three lists above.
  //
  // It did not, and the consequence was quiet: a value that is not an array was
  // discarded, time_active became 0, and rule 6 in the circuit is
  // `1 - time_active + time_active * compliant`, which is exactly 1 when
  // time_active is 0. The window stopped being enforced. Nothing in the response
  // showed it, because the off-circuit evaluator short-circuits on the same
  // field, so rules_agree stayed true and violated_rules stayed empty.
  //
  // hash.js already takes the opposite position two files over, and says why:
  // it throws on an unknown weekday name "so a restriction is never silently
  // downgraded". A malformed record is a larger downgrade than a misspelt day.
  if (req.time_restrictions !== undefined && req.time_restrictions !== null) {
    if (!Array.isArray(req.time_restrictions)) {
      throw new Error('time_restrictions: must be an array');
    }

    // One window, or none. Anything past the first used to be validated and
    // then dropped: buildCircuitInput reads `[0]` and nothing else, so a second
    // record was checked field by field, accepted, and never reached the
    // circuit. square#181 measured it -- two records in, the first one's window
    // out, no trace of the second.
    //
    // Validating every entry is a statement that plural is supported. It is
    // not, and it cannot be without a circuit change: the commitment's eighth
    // field is `time_field = Poseidon(1, days_bitmask, start, end)`
    // (payment.circom), which is one window and has room for exactly one. A
    // policy whose second window is invisible to the proof is a policy the
    // chain's commitment and the caller disagree about.
    //
    // So it is refused at the door, the same answer square#148 gave the window
    // that crosses midnight, and for the same reason: better to say the limit
    // than to accept a policy and silently honour half of it.
    if (req.time_restrictions.length > 1) {
      throw new Error(
        `time_restrictions: ${req.time_restrictions.length} entries were given and only one `
        + 'window can be proved. The commitment covers a single window, so anything after '
        + 'the first would be accepted here and never reach the circuit. Send one entry.',
      );
    }

    for (const restriction of req.time_restrictions) {
      if (typeof restriction !== 'object' || restriction === null || Array.isArray(restriction)) {
        throw new Error('time_restrictions: each entry must be an object');
      }
      // No defaults. `?? []` on the days meant an empty mask — every weekday
      // forbidden — and `?? 0` on the hours meant a window of 00:00 to 00:59.
      // Both are policies somebody might mean and nobody would mean by accident,
      // so a caller has to say them.
      for (const field of ['allowed_days', 'allowed_hours_start', 'allowed_hours_end']) {
        if (restriction[field] === undefined || restriction[field] === null) {
          throw new Error(`time_restrictions.${field}: required when a restriction is given`);
        }
      }
      if (!Array.isArray(restriction.allowed_days)) {
        throw new Error('time_restrictions.allowed_days: must be an array');
      }

      // An empty day list is the same class of value as the defaults refused
      // above: it forbids every weekday, so the rule can never be satisfied and
      // every payment under the policy is refused with 'time_window'. A
      // `.filter()` that matched nothing, or an empty form field, produces it.
      //
      // hash.js already throws on a weekday name it does not recognise, "so a
      // restriction is never silently downgraded". Zero recognised days is the
      // larger downgrade of the two, and it was the one getting through.
      //
      // "No window at all" is a different policy and has its own spelling:
      // leave time_restrictions out, and the rule is off.
      if (restriction.allowed_days.length === 0) {
        throw new Error(
          'time_restrictions.allowed_days: must name at least one day. An empty list '
          + 'forbids every weekday, so no payment could ever satisfy the rule; omit '
          + 'time_restrictions entirely to leave the window unrestricted.',
        );
      }

      // The timezone, here rather than in buildCircuitInput.
      //
      // It used to be checked on `[0]` only, after validation, which meant a
      // second record could carry America/New_York and never be looked at --
      // the same value that is refused when it is sent on its own. With one
      // record enforced above this is the only record there is, and checking it
      // with the rest keeps every reason a request is refused in one function
      // and on one status code.
      if (restriction.timezone !== undefined && restriction.timezone !== null
        && restriction.timezone !== 'UTC') {
        throw new Error("time_restrictions.timezone: only 'UTC' is supported");
      }

      // The hours, in range, before anything is hashed. openapi.js has declared
      // 0..23 all along and nothing enforced it; square#148 measured what got
      // through. 24..31 is accepted by the circuit's Num2Bits(5) and is not an
      // hour: an end of 31 behaves like 23, a start of 25 empties the window and
      // every payment under that policy is refused with 'time_window' and no way
      // to tell a bad payment from a broken policy. 32 and above fails inside
      // witness generation, where the caller gets a constraint error rather than
      // the name of the field they got wrong.
      const startHour = toHourString(
        restriction.allowed_hours_start, 'time_restrictions.allowed_hours_start',
      );
      const endHour = toHourString(
        restriction.allowed_hours_end, 'time_restrictions.allowed_hours_end',
      );

      // A window that runs past midnight is refused, and the message says so.
      //
      // The circuit computes `hour >= start AND hour <= end` and says in its own
      // comment that it assumes start <= end; rules.js mirrors the same
      // limitation deliberately, so that the two agree. They do agree -- on
      // accepting a policy that can never be satisfied. 22:00 to 06:00 is a
      // perfectly ordinary thing to want for an agent that works overnight, and
      // under it *no* hour of *any* day is inside the window, so every payment is
      // refused. The response is identical to a payment that genuinely missed its
      // window, and rules_agree stays true, so nothing in the system says which
      // one happened.
      //
      // Modelling it is a circuit change -- an OR branch selected by start > end,
      // mirrored in rules.js and pinned by circuit-agreement.test.js. Until that
      // is done the honest answer is to refuse the policy at the door rather than
      // accept it and refuse everything it covers. See circuits/README.md, rule 6.
      if (BigInt(startHour) > BigInt(endHour)) {
        throw new Error(
          'time_restrictions: allowed_hours_start must not be later than '
          + 'allowed_hours_end. A window that crosses midnight is not modelled; '
          + 'express it as two policies, or one window per side of midnight.',
        );
      }
    }
  }
}

// Shape an incoming HTTP payload into the witness inputs the circuit expects.
//
// Amounts are USDC base units at 6 decimals, not wei — see
// docs/decisions/erc20-vs-native-usdc.md. The circuit range-checks them to 64
// bits, so an 18-decimal figure fails witness generation rather than being
// silently truncated.
export async function buildCircuitInput(request) {
  validateRequest(request);

  const tokens = padAddressList(request.token_whitelist, MAX_WHITELIST, 'token_whitelist');
  const blocked = padAddressList(request.blocked_addresses, MAX_BLOCKED, 'blocked_addresses');
  const categories = await padCategoryList(
    request.allowed_endpoint_categories,
    MAX_CATEGORIES,
    'allowed_endpoint_categories',
  );

  // Time restriction. Default = inactive. The circuit muxes the time hash to 0
  // when time_active == 0, so the off-chain commitment and the in-circuit one
  // agree on a policy with no window.
  //
  // `[0]` is the whole list now, not the head of it: validateRequest refuses a
  // second entry rather than letting this line drop it (square#181). The
  // timezone moved there too, so every reason a request is refused is in one
  // function and answers 400.
  const tr = Array.isArray(request.time_restrictions) ? request.time_restrictions[0] : null;
  // No `??` fallbacks any more: validateRequest requires all three when a
  // restriction is present, so a missing field is an error rather than a window
  // of 00:00 to 00:59 with every weekday forbidden.
  const timeActive = tr ? '1' : '0';
  const timeDaysBitmask = tr ? String(daysToBitmask(tr.allowed_days)) : '0';
  const timeStartHourUtc = tr
    ? toHourString(tr.allowed_hours_start, 'time_restrictions.allowed_hours_start')
    : '0';
  const timeEndHourUtc = tr
    ? toHourString(tr.allowed_hours_end, 'time_restrictions.allowed_hours_end')
    : '0';

  return {
    // Policy (private)
    max_per_tx: toFieldString(request.max_per_transaction, 'max_per_transaction'),
    max_daily: toFieldString(request.max_daily_spend, 'max_daily_spend'),
    token_whitelist: tokens,
    blocked_addresses: blocked,
    allowed_categories: categories,
    payment_category: await hashCategory(
      request.payment_endpoint_category,
      'payment_endpoint_category',
    ),
    operator_id_field: addressToField(request.operator_id, 'operator_id'),
    policy_id_field: await hashUuid(request.policy_id, 'policy_id'),

    // One per committed field, in the order the circuit hashes them. See
    // commitment.js — the same construction, and the only two places it exists.
    policy_salts: (await deriveSalts(
      // The same floor validateRequest applies, so the bound has one home.
      toPolicySaltString(request.policy_salt, 'policy_salt'),
    )).map(String),
    time_active: timeActive,
    time_days_bitmask: timeDaysBitmask,
    time_start_hour_utc: timeStartHourUtc,
    time_end_hour_utc: timeEndHourUtc,

    // Payment (mirrored to the public signals). A 20-byte address is one field
    // element, which is what took the layout from ten signals to eight.
    recipient_in: addressToField(request.payment_recipient, 'payment_recipient'),
    amount_in: toFieldString(request.payment_amount, 'payment_amount'),
    token_in: addressToField(request.payment_token, 'payment_token'),
    daily_spent_before_in: toFieldString(request.daily_spent_before, 'daily_spent_before'),
    current_unix_timestamp_in: toFieldString(
      request.current_unix_timestamp,
      'current_unix_timestamp',
    ),
    stripe_receipt_hash_in: toFieldString(
      request.stripe_receipt_hash ?? '0',
      'stripe_receipt_hash',
    ),
  };
}

export async function generateProof(request) {
  // Narrow the operator id before anything else touches it, so the value the
  // violation log is allowed to print has already been checked.
  const operatorId = toIdentifier(request.operator_id, 'operator_id');

  const circuitInput = await buildCircuitInput(request);

  // Evaluate the rules off-circuit before proving. The circuit answers "is this
  // compliant"; this answers "which rule failed", which is the part the
  // violation log is allowed to say out loud.
  const evaluation = await evaluateRules(circuitInput);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  if (publicSignals.length !== EXPECTED_PUBLIC_SIGNALS) {
    throw new Error(
      `Circuit produced ${publicSignals.length} public signals, expected `
      + `${EXPECTED_PUBLIC_SIGNALS} — circuit and prover service are out of sync.`,
    );
  }

  const signals = {};
  PUBLIC_SIGNAL_ORDER.forEach((name, i) => { signals[name] = publicSignals[i]; });

  const isCompliant = signals.is_compliant === '1';
  const policyDataHashHex = BigInt(signals.policy_data_hash).toString(16).padStart(64, '0');

  return {
    operator_id: operatorId,
    is_compliant: isCompliant,

    // Which rules failed, by name. Empty when compliant. Safe to log and safe
    // to return: the caller supplied the policy these names refer to, and a
    // name reveals which check ran, not what it was set to.
    violated_rules: evaluation.violated,

    // True when the circuit and the off-circuit evaluator agree. False means
    // violated_rules cannot be trusted for this request.
    rules_agree: evaluation.compliant === isCompliant,

    policy_data_hash: signals.policy_data_hash,
    policy_data_hash_hex: policyDataHashHex,
    public_signals: signals,

    // Ready to pass to the on-chain verifier's verifyProof(a, b, c, input).
    solidity: encodeForSolidity(proof, publicSignals),
    raw_proof: proof,
    raw_public: publicSignals,

    verification_timestamp: new Date().toISOString(),
  };
}
