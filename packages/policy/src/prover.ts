import type { Address } from "viem";
import type { Policy } from "./policy.js";
import type { SolidityProof } from "./proof.js";

/** What a release looks like to the circuit: the payment half of `POST /prove`. */
export interface Payment {
  /** Who the kernel will pay: `payeeOf(jobId)`, the buyer of a sold receivable, else the provider. */
  recipient: Address;
  /** The net payout, USDC atomic units: `netPayout(jobId)`. */
  amount: bigint;
  /** The payment token: the deployment's USDC. */
  token: Address;
  /** One of the policy's `allowed_endpoint_categories`; the capability the job bought. */
  category: string;
  /** `PolicyRegistry.spentToday(client)` at the moment of release. */
  dailySpentBefore: bigint;
  /** The chain's clock, seconds; the module accepts it within its tolerance of the releasing block. */
  timestamp: bigint;
}

/** The body of `POST /prove`, the prover's vocabulary throughout. */
export interface ProveRequest extends Policy {
  payment_amount: string;
  payment_token: Address;
  payment_recipient: Address;
  payment_endpoint_category: string;
  daily_spent_before: string;
  current_unix_timestamp: string;
  stripe_receipt_hash?: string;
}

export type ViolatedRule = "per_transaction_limit" | "daily_limit" | "token_whitelist" | "blocked_recipient" | "endpoint_category" | "time_window";

export interface ProveResponse {
  is_compliant: boolean;
  /** Empty when compliant; null when the circuit and the evaluator disagreed and no name can be trusted. */
  violated_rules: ViolatedRule[] | null;
  policy_data_hash: string;
  policy_data_hash_hex: string;
  public_signals: Record<string, string>;
  solidity: SolidityProof;
  proving_time_ms?: number;
}

export interface Prover {
  prove(request: ProveRequest, options?: { signal?: AbortSignal | undefined }): Promise<ProveResponse>;
}

export class ProverError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "ProverError";
  }
}

/** The request for one release under one policy. */
export function proveRequest(policy: Policy, payment: Payment): ProveRequest {
  return {
    ...policy,
    payment_amount: payment.amount.toString(),
    payment_token: payment.token,
    payment_recipient: payment.recipient,
    payment_endpoint_category: payment.category,
    daily_spent_before: payment.dailySpentBefore.toString(),
    current_unix_timestamp: payment.timestamp.toString(),
  };
}

export interface ProverClientOptions {
  /** The prover service's origin, `http://127.0.0.1:3003` for a local one. */
  url: string;
  fetch?: typeof globalThis.fetch | undefined;
  /** A Groth16 proof takes seconds; the default allows a slow machine a minute. */
  timeoutMs?: number | undefined;
}

/**
 * `POST /prove` at the prover service (services/prover). The request carries
 * the whole policy, its secret included, so whoever runs that service can open
 * every committed value. The institution's own tools prove in their own
 * process instead, with `createLocalProver` from `@squaresdk/policy/node`
 * (square#347, docs/decisions/prover-trust-boundary.md); this client is for a
 * page that cannot, the app's job page, and for development.
 */
export function createProverClient(options: ProverClientOptions): Prover {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    async prove(request, callOptions = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new ProverError(`the prover at ${base} did not answer within ${timeoutMs} ms`, undefined)), timeoutMs);
      const abort = () => controller.abort(callOptions.signal?.reason);
      callOptions.signal?.addEventListener("abort", abort, { once: true });
      try {
        let response: Response;
        try {
          response = await fetchImpl(`${base}/prove`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted && controller.signal.reason instanceof ProverError) throw controller.signal.reason;
          throw new ProverError(`the prover at ${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`, undefined);
        }
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new ProverError(`the prover at ${base} answered ${response.status} with a body that is not JSON`, response.status);
        }
        if (!response.ok) {
          const error = (body as { error?: unknown }).error;
          throw new ProverError(`the prover refused the request (${response.status}): ${typeof error === "string" ? error : text.slice(0, 200)}`, response.status);
        }
        const result = body as ProveResponse;
        if (typeof result.is_compliant !== "boolean" || !result.solidity || !Array.isArray(result.solidity.input)) {
          throw new ProverError(`the prover at ${base} answered without a proof`, response.status);
        }
        return result;
      } finally {
        clearTimeout(timer);
        callOptions.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
