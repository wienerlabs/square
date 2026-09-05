import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  padAddressList,
  padCategoryList,
  hashAddress,
  hashCategory,
  hashUuid,
  daysToBitmask,
  decodeAddress32,
  splitBytes,
} from './hash.js';
import { toFieldString, toIdentifier } from './normalize.js';
import { evaluateRules } from './rules.js';
import { encodeForGroth16Solana } from './convert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACTS_DIR = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(__dirname, '..', 'artifacts');
const WASM_PATH = path.join(ARTIFACTS_DIR, 'payment.wasm');
const ZKEY_PATH = path.join(ARTIFACTS_DIR, 'payment.zkey');

// Fixed list sizes must match the template parameters used in the circuit:
//   component main = PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES)
const MAX_WHITELIST = 10;
const MAX_BLOCKED = 10;
const MAX_CATEGORIES = 8;

// The circuit exposes ten public signals today. #14 re-parameterises it to
// eight by folding recipient_high/low and token_mint_high/low into single field
// elements for EVM addresses, and #18 updates this service to match. The guard
// below is deliberately strict in both directions: a circuit and a prover that
// disagree about the public layout produce proofs that verify against the wrong
// statement, which is worse than a hard failure.
const EXPECTED_PUBLIC_SIGNALS = 10;

const PUBLIC_SIGNAL_ORDER = [
  'is_compliant',
  'policy_data_hash',
  'recipient_high',
  'recipient_low',
  'amount_lamports',
  'token_mint_high',
  'token_mint_low',
  'daily_spent_before',
  'current_unix_timestamp',
  'stripe_receipt_hash',
];

// Validate that an incoming request carries every field the circuit needs.
// Surface a clear error per missing field instead of letting snarkjs crash deep
// inside witness generation. Field names only — never their values.
function validateRequest(req) {
  const required = [
    'policy_id',
    'operator_id',
    'max_daily_spend_lamports',
    'max_per_transaction_lamports',
    'allowed_endpoint_categories',
    'blocked_addresses',
    'token_whitelist',
    'payment_amount_lamports',
    'payment_token_mint',
    'payment_recipient',
    'payment_endpoint_category',
    'daily_spent_before_lamports',
    'current_unix_timestamp',
    // stripe_receipt_hash is OPTIONAL — defaults to '0' for the pure on-chain
    // flow. A non-zero value carries the Poseidon commitment over a Stripe
    // receipt for the MPP path.
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
// The payload mirrors the on-chain truth at proof time (recipient, amount,
// mint, daily_spent_before, current_unix_timestamp); none of these may be
// fabricated by the caller, because the verifier cross-checks them against the
// settlement it is gating.
export async function buildCircuitInput(request) {
  validateRequest(request);

  const tokens = await padAddressList(
    request.token_whitelist,
    MAX_WHITELIST,
    'token_whitelist',
  );
  const blocked = await padAddressList(
    request.blocked_addresses,
    MAX_BLOCKED,
    'blocked_addresses',
  );
  const categories = await padCategoryList(
    request.allowed_endpoint_categories,
    MAX_CATEGORIES,
    'allowed_endpoint_categories',
  );

  // Time restriction. Default = inactive (no time gate). The circuit muxes the
  // time hash to 0 when time_active == 0, so the off-chain policy commitment
  // and the in-circuit one agree.
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

  // Split the payment recipient and token mint into 16+16 byte halves the
  // circuit exposes verbatim as public outputs. The verifier reads these off
  // the proof and compares them against the settlement being gated.
  const recipientBytes = decodeAddress32(request.payment_recipient, 'payment_recipient');
  const tokenBytes = decodeAddress32(request.payment_token_mint, 'payment_token_mint');
  const [recipientHigh, recipientLow] = splitBytes(recipientBytes);
  const [tokenHigh, tokenLow] = splitBytes(tokenBytes);

  const operatorIdField = await hashAddress(request.operator_id, 'operator_id');
  const policyIdField = await hashUuid(request.policy_id, 'policy_id');
  const paymentCategoryField = await hashCategory(
    request.payment_endpoint_category,
    'payment_endpoint_category',
  );

  return {
    // Policy (private)
    max_per_tx_lamports: toFieldString(
      request.max_per_transaction_lamports,
      'max_per_transaction_lamports',
    ),
    max_daily_lamports: toFieldString(
      request.max_daily_spend_lamports,
      'max_daily_spend_lamports',
    ),
    token_whitelist: tokens.values,
    token_whitelist_mask: tokens.mask,
    blocked_addresses: blocked.values,
    blocked_addresses_mask: blocked.mask,
    allowed_categories: categories.values,
    allowed_categories_mask: categories.mask,
    payment_category: paymentCategoryField,
    operator_id_field: operatorIdField,
    policy_id_field: policyIdField,
    time_active: timeActive,
    time_days_bitmask: timeDaysBitmask,
    time_start_hour_utc: timeStartHourUtc,
    time_end_hour_utc: timeEndHourUtc,

    // Payment (mirrored to public outputs)
    recipient_high_in: recipientHigh.toString(),
    recipient_low_in: recipientLow.toString(),
    amount_lamports_in: toFieldString(
      request.payment_amount_lamports,
      'payment_amount_lamports',
    ),
    token_mint_high_in: tokenHigh.toString(),
    token_mint_low_in: tokenLow.toString(),
    daily_spent_before_in: toFieldString(
      request.daily_spent_before_lamports,
      'daily_spent_before_lamports',
    ),
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
      `Circuit produced ${publicSignals.length} public signals, expected ` +
      `${EXPECTED_PUBLIC_SIGNALS} — circuit and prover service are out of sync.`,
    );
  }

  const signals = {};
  PUBLIC_SIGNAL_ORDER.forEach((name, i) => { signals[name] = publicSignals[i]; });

  const isCompliant = signals.is_compliant === '1';
  const encoded = encodeForGroth16Solana(proof, publicSignals);
  const policyDataHashHex = BigInt(signals.policy_data_hash).toString(16).padStart(64, '0');

  return {
    operator_id: operatorId,
    is_compliant: isCompliant,

    // Which rules failed, by name. Empty when the payment is compliant. Safe to
    // log and safe to return: the caller supplied the policy these names refer
    // to, and a name reveals which check ran, not what it was set to.
    violated_rules: evaluation.violated,

    // True when the circuit and the off-circuit evaluator agree. False means
    // violated_rules cannot be trusted for this request and the caller should
    // say so rather than report a rule name.
    rules_agree: evaluation.compliant === isCompliant,

    policy_data_hash: signals.policy_data_hash,
    policy_data_hash_hex: policyDataHashHex,
    public_signals: signals,
    groth16: encoded,
    raw_proof: proof,
    raw_public: publicSignals,

    // The verifier seeds its proof record by policy_data_hash, so callers can
    // derive the same key off-chain by hex-decoding policy_data_hash_hex.
    // proof_hash is kept as an alias for callers that recorded the field under
    // that name; it is the same 32-byte commitment.
    proof_hash: policyDataHashHex,
    verification_timestamp: new Date().toISOString(),
    receipt_bytes: Array.from(
      Buffer.concat([
        Buffer.from(encoded.proof_a, 'base64'),
        Buffer.from(encoded.proof_b, 'base64'),
        Buffer.from(encoded.proof_c, 'base64'),
      ]),
    ),
  };
}
