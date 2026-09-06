import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  padAddressList,
  padCategoryList,
  addressToField,
  hashCategory,
  hashUuid,
  daysToBitmask,
} from './hash.js';
import { toFieldString, toIdentifier } from './normalize.js';
import { evaluateRules } from './rules.js';
import { encodeForSolidity } from './convert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACTS_DIR = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(__dirname, '..', 'artifacts');
const WASM_PATH = path.join(ARTIFACTS_DIR, 'payment.wasm');
const ZKEY_PATH = path.join(ARTIFACTS_DIR, 'payment.zkey');

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
function validateRequest(req) {
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
    // stripe_receipt_hash is OPTIONAL and defaults to '0'.
  ];
  const missing = required.filter((k) => req[k] === undefined || req[k] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  }

  for (const key of ['allowed_endpoint_categories', 'blocked_addresses', 'token_whitelist']) {
    if (!Array.isArray(req[key])) {
      throw new Error(`${key}: must be an array`);
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
  const tr = Array.isArray(request.time_restrictions) ? request.time_restrictions[0] : null;
  if (tr && tr.timezone && tr.timezone !== 'UTC') {
    throw new Error("time_restrictions.timezone: only 'UTC' is supported");
  }
  const timeActive = tr ? '1' : '0';
  const timeDaysBitmask = tr ? String(daysToBitmask(tr.allowed_days ?? [])) : '0';
  const timeStartHourUtc = tr
    ? toFieldString(tr.allowed_hours_start ?? 0, 'time_restrictions.allowed_hours_start')
    : '0';
  const timeEndHourUtc = tr
    ? toFieldString(tr.allowed_hours_end ?? 0, 'time_restrictions.allowed_hours_end')
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
