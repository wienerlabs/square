import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as snarkjs from "snarkjs";
import { addressToField, daysToBitmask, deriveSalts, hashCategory, hashUuid } from "./commitment.js";
import { BN254_R, MAX_BLOCKED, MAX_CATEGORIES, MAX_CATEGORY_BYTES, MAX_WHITELIST, parsePolicy, PolicyError, type Policy } from "./policy.js";
import { SIGNALS, type SolidityProof } from "./proof.js";
import { ProverError, type ProveRequest, type ProveResponse, type Prover, type ViolatedRule } from "./prover.js";

/**
 * The proof, made in this process (square#347).
 *
 * A request to `POST /prove` carries the whole policy, `policy_salt` with it,
 * and whoever runs that service can open every committed value. So the
 * institution's own tools — the CLI, the MCP server, the hosted agent — prove
 * here instead, from the circuit's files on this machine, and the policy never
 * crosses a process boundary: the chain gets the commitment and the proof, and
 * nobody gets the policy ([docs/decisions/prover-trust-boundary.md]).
 *
 * The circuit input is built the way services/prover/src/prover.js
 * `buildCircuitInput` builds it, and the six rules are evaluated the way
 * rules.js evaluates them, for the names of the rules a refused release broke;
 * test/local-prover.test.ts holds both to the prover's own functions whenever
 * the prover is installed beside this package. Every proof is checked against
 * `payment_vk.json` before it is returned: that is the file
 * scripts/install-module-for-this-build.mjs keys a module to, so a zkey from
 * another key is named here rather than refused, without a reason, at release.
 */

/** The files a proving directory holds: what services/prover reads from `PROVER_ARTIFACTS_DIR`. */
export const ARTIFACT_FILES = { wasm: "payment.wasm", zkey: "payment.zkey", verificationKey: "payment_vk.json" } as const;

export interface LocalProverOptions {
  /** The directory holding `payment.wasm`, `payment.zkey` and `payment_vk.json`; `SQUARE_PROVER_ARTIFACTS` for the binaries. */
  artifacts: string;
}

export interface LocalProver extends Prover {
  /** The directory the files are read from, resolved. */
  readonly artifacts: string;
  /**
   * Stop snarkjs's worker threads. It keeps them for the next proof, and a
   * process that proved once does not exit while they run; a one-shot command
   * calls this when it is done.
   */
  close(): Promise<void>;
}

// payment.circom: PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES), eight public signals.
const EXPECTED_PUBLIC_SIGNALS = SIGNALS.length;
const SECONDS_PER_DAY = 86_400n;
const SECONDS_PER_HOUR = 3_600n;
// 1970-01-01 was a Thursday; the circuit's weekdays are Monday = 0.
const EPOCH_WEEKDAY_OFFSET = 3n;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A proving directory as a `Prover`. Throws when one of the three files is not there. */
export function createLocalProver(options: LocalProverOptions): LocalProver {
  const dir = resolve(options.artifacts);
  const paths = { wasm: join(dir, ARTIFACT_FILES.wasm), zkey: join(dir, ARTIFACT_FILES.zkey), verificationKey: join(dir, ARTIFACT_FILES.verificationKey) };
  const missing = Object.values(paths).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new ProverError(`no proving artifacts at ${dir}: ${missing.map((path) => path.slice(dir.length + 1)).join(", ")} missing; build the circuit (circuits: npm run build) or copy the ceremony's files there`, undefined);
  }
  const verificationKey = JSON.parse(readFileSync(paths.verificationKey, "utf8")) as unknown;

  return {
    artifacts: dir,
    async prove(request, callOptions = {}) {
      callOptions.signal?.throwIfAborted();
      const input = await circuitInput(request);
      const evaluation = evaluateRules(input);
      const started = Date.now();
      let proved: Awaited<ReturnType<typeof snarkjs.groth16.fullProve>>;
      try {
        proved = await snarkjs.groth16.fullProve(input, paths.wasm, paths.zkey);
      } catch (error) {
        throw new ProverError(`the circuit at ${dir} produced no proof for this request: ${error instanceof Error ? error.message : String(error)}`, undefined);
      }
      const { proof, publicSignals } = proved;
      if (publicSignals.length !== EXPECTED_PUBLIC_SIGNALS) {
        throw new ProverError(`the circuit at ${dir} produced ${publicSignals.length} public signals, expected ${EXPECTED_PUBLIC_SIGNALS}; the files are not this circuit's`, undefined);
      }
      if (!(await snarkjs.groth16.verify(verificationKey, publicSignals, proof))) {
        throw new ProverError(`the proof does not verify against ${paths.verificationKey}: ${ARTIFACT_FILES.zkey} and ${ARTIFACT_FILES.verificationKey} come from different keys, and a module keyed to the second refuses every proof of the first`, undefined);
      }
      const provingTimeMs = Date.now() - started;
      const signals = Object.fromEntries(SIGNALS.map((name, i) => [name, publicSignals[i]!]));
      const isCompliant = signals["is_compliant"] === "1";
      return {
        is_compliant: isCompliant,
        // As the service answers: null when the circuit and the evaluator disagree, because then no name can be trusted.
        violated_rules: evaluation.compliant === isCompliant ? evaluation.violated : null,
        policy_data_hash: signals["policy_data_hash"]!,
        policy_data_hash_hex: BigInt(signals["policy_data_hash"]!).toString(16).padStart(64, "0"),
        public_signals: signals,
        solidity: encodeForSolidity(proof, publicSignals),
        proving_time_ms: provingTimeMs,
      } satisfies ProveResponse;
    },
    async close() {
      const holder = globalThis as { curve_bn128?: { terminate(): Promise<void> } | null };
      const curve = holder.curve_bn128;
      if (curve) {
        holder.curve_bn128 = null;
        await curve.terminate();
      }
    },
  };
}

function refuse(message: string): never {
  throw new ProverError(`the request is refused: ${message}`, undefined);
}

function fieldString(value: unknown, label: string): string {
  const text = typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
  if (text === null || !INTEGER.test(text)) refuse(`${label}: must be a non-negative integer`);
  if (BigInt(text) >= BN254_R) refuse(`${label}: does not fit in the BN254 scalar field`);
  return text;
}

function lookupAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value.trim())) refuse(`${label}: must be a 20-byte hex address`);
  const element = addressToField(value);
  if (element === 0n) refuse(`${label}: must not be the zero address; the circuit rejects a zero lookup key`);
  return element.toString();
}

const padded = (values: readonly bigint[], length: number): string[] => [...values.map(String), ...Array.from({ length: length - values.length }, () => "0")];

/** services/prover/src/prover.js `buildCircuitInput`, from a request `parsePolicy` and the checks below accept. */
export async function circuitInput(request: ProveRequest): Promise<Record<string, string | string[]>> {
  let policy: Policy;
  try {
    policy = parsePolicy(request);
  } catch (error) {
    if (error instanceof PolicyError) refuse(error.message);
    throw error;
  }
  const category = request.payment_endpoint_category;
  if (typeof category !== "string" || category.length === 0 || new TextEncoder().encode(category).length > MAX_CATEGORY_BYTES) {
    refuse(`payment_endpoint_category: must be a string of 1 to ${MAX_CATEGORY_BYTES} bytes`);
  }
  const paymentCategory = await hashCategory(category);
  if (paymentCategory === 0n) refuse("payment_endpoint_category: must not encode to zero");
  const recipient = lookupAddress(request.payment_recipient, "payment_recipient");
  const token = lookupAddress(request.payment_token, "payment_token");

  const window = policy.time_restrictions?.[0];
  return {
    max_per_tx: policy.max_per_transaction,
    max_daily: policy.max_daily_spend,
    token_whitelist: padded(policy.token_whitelist.map(addressToField), MAX_WHITELIST),
    blocked_addresses: padded(policy.blocked_addresses.map(addressToField), MAX_BLOCKED),
    allowed_categories: padded(await Promise.all(policy.allowed_endpoint_categories.map((c) => hashCategory(c))), MAX_CATEGORIES),
    payment_category: paymentCategory.toString(),
    operator_id_field: addressToField(policy.operator_id).toString(),
    policy_id_field: (await hashUuid(policy.policy_id)).toString(),
    policy_salts: (await deriveSalts(policy.policy_salt)).map(String),
    // With no window the three are 0, a requirement of the circuit (square#256): it range-checks them whatever time_active is.
    time_active: window ? "1" : "0",
    time_days_bitmask: window ? daysToBitmask(window.allowed_days).toString() : "0",
    time_start_hour_utc: window ? String(window.allowed_hours_start) : "0",
    time_end_hour_utc: window ? String(window.allowed_hours_end) : "0",
    recipient_in: recipient,
    amount_in: fieldString(request.payment_amount, "payment_amount"),
    token_in: token,
    daily_spent_before_in: fieldString(request.daily_spent_before, "daily_spent_before"),
    current_unix_timestamp_in: fieldString(request.current_unix_timestamp, "current_unix_timestamp"),
    stripe_receipt_hash_in: fieldString(request.stripe_receipt_hash ?? "0", "stripe_receipt_hash"),
  };
}

function isInList(needle: bigint, values: readonly string[], key: string): boolean {
  if (needle === 0n) throw new ProverError(`${key}: lookup key is zero; the circuit rejects this witness`, undefined);
  return values.some((value) => BigInt(value) === needle);
}

/** services/prover/src/rules.js `evaluateRules`: the names of the rules the circuit input breaks. */
export function evaluateRules(input: Record<string, string | string[]>): { compliant: boolean; violated: ViolatedRule[] } {
  const scalar = (key: string) => BigInt(input[key] as string);
  const list = (key: string) => input[key] as string[];
  const violated: ViolatedRule[] = [];
  const amount = scalar("amount_in");
  if (amount > scalar("max_per_tx")) violated.push("per_transaction_limit");
  if (scalar("daily_spent_before_in") + amount > scalar("max_daily")) violated.push("daily_limit");
  if (!isInList(scalar("token_in"), list("token_whitelist"), "payment_token (token_in)")) violated.push("token_whitelist");
  if (isInList(scalar("recipient_in"), list("blocked_addresses"), "payment_recipient (recipient_in)")) violated.push("blocked_recipient");
  if (!isInList(scalar("payment_category"), list("allowed_categories"), "payment_endpoint_category (payment_category)")) violated.push("endpoint_category");
  if (scalar("time_active") !== 0n) {
    const timestamp = scalar("current_unix_timestamp_in");
    const hour = (timestamp % SECONDS_PER_DAY) / SECONDS_PER_HOUR;
    const weekday = (timestamp / SECONDS_PER_DAY + EPOCH_WEEKDAY_OFFSET) % 7n;
    const dayActive = ((scalar("time_days_bitmask") >> weekday) & 1n) === 1n;
    if (!(dayActive && hour >= scalar("time_start_hour_utc") && hour <= scalar("time_end_hour_utc"))) violated.push("time_window");
  }
  return { compliant: violated.length === 0, violated };
}

const hex32 = (value: string): string => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

/** services/prover/src/convert.js `encodeForSolidity`: the verifier's `(a, b, c, input)`, each G2 coordinate as (im, re). */
function encodeForSolidity(proof: snarkjs.Groth16Proof, publicSignals: readonly string[]): SolidityProof {
  const [ax, ay] = proof.pi_a;
  const [[bx0, bx1], [by0, by1]] = proof.pi_b as [[string, string], [string, string]];
  const [cx, cy] = proof.pi_c;
  return {
    a: [hex32(ax!), hex32(ay!)],
    b: [
      [hex32(bx1), hex32(bx0)],
      [hex32(by1), hex32(by0)],
    ],
    c: [hex32(cx!), hex32(cy!)],
    input: publicSignals.map(hex32),
  };
}
