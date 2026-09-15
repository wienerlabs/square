import { A2AClient, A2AError, JOB_STATUS_NAMES, TaskState, type TaskStatusResult } from "@squaresdk/a2a";
import { JobStatus, PartyNotClearedError, type JobStatusValue, type SquareClient } from "@squaresdk/core";
import { formatUnits, isAddressEqual, parseUnits, type Address, type Hex } from "viem";
import type { AgentProfile } from "./agents.js";

const ZERO32 = `0x${"0".repeat(64)}`;

export interface HireOptions {
  /** The wallet that pays: it becomes the job's client. */
  client: SquareClient;
  a2a: A2AClient;
  /** From `lookupAgent`. */
  profile: AgentProfile;
  capability: string;
  input: string;
  /** Decimal USDC to escrow. Defaults to the capability's price; required when it has none. */
  budget?: string | undefined;
  /** How long the agent has. Default `jobDays`, or a day past the settlement horizon if that is longer. */
  expiresInDays?: number | undefined;
  jobDays?: number | undefined;
  /** The DID the task is created under. */
  callerDid: string;
  /** How long to wait for the task before handing back the ids to poll with. Default 50 s. */
  taskTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  /**
   * Asked before any transaction, with the amount about to be escrowed. A
   * reason refuses the hire before it spends; undefined lets it go on. A
   * host that keeps an allowance answers here.
   */
  admit?: ((amount: bigint) => Promise<string | undefined>) | undefined;
  /** Told once the job is funded, before the task is dispatched, so a host's ledger sees every job this wallet holds escrow on. */
  onFunded?: ((job: { jobId: bigint; budget: bigint; provider: Address }) => void | Promise<void>) | undefined;
  /**
   * A job this wallet already opened, to carry on with instead of creating
   * another (square#351): a hire whose `fund` failed leaves an Open job with
   * its budget set, and a second `hire` would open a second one. The job
   * has to be this wallet's and still Open; its budget is used when it has
   * one and `budget` does not say otherwise.
   */
  jobId?: bigint | undefined;
  /** How long to wait before the one automatic second attempt at dispatching. Default 1 s; 0 sends it at once. */
  redispatchDelayMs?: number | undefined;
}

export interface HireTransactions {
  createJob: Hex;
  setBudget: Hex;
  fund: Hex;
}

/** What a hire leaves behind once the job is funded. */
export interface HireResult {
  jobId: bigint;
  taskId: string;
  /** USDC atomic units. */
  budget: bigint;
  provider: Address;
  transactions: HireTransactions;
  /**
   * `delivered` and `failed` are the task's terminal states; `working` is
   * the wait running out with the task still going; `undispatched` is A2A
   * refusing or not answering, with the escrow already on the job.
   */
  dispatch: "delivered" | "failed" | "working" | "undispatched";
  /** The task as the agent last reported it; absent when it was never accepted. */
  task?: TaskStatusResult;
  /** The task's failure reason, or why it could not be dispatched. */
  reason?: string;
}

/**
 * A hire refused before the job was funded, or one whose funding failed
 * part way: nothing is escrowed in the first case, and `transactions` says
 * what landed in the second.
 */
export class HireRefusedError extends Error {
  constructor(
    message: string,
    readonly stage: "before-funding" | "funding",
    readonly transactions: Partial<HireTransactions> = {},
  ) {
    super(message);
    this.name = "HireRefusedError";
  }
}

const HOUR = 3_600;
const DAY = 86_400;

/**
 * Escrow a job for an agent and give it the task: `createJob` for the
 * agent's wallet, `setBudget` with the capability's price or the budget
 * given, `fund`, then `task/create` over A2A and polling until the task
 * ends or the wait runs out.
 *
 * Everything that can be seen to fail is refused before the first
 * transaction: a capability the agent does not offer, a budget below its
 * price, a wallet that cannot cover it, an expiry inside the settlement
 * horizon (the agent's `submit` needs the horizon ahead of expiry), a
 * deactivated agent, a host's allowance saying no. Once the job is funded
 * the escrow is the chain's, and whatever A2A answers afterwards comes back
 * in `dispatch` with the job id, never as a throw: the money is on the job
 * either way, and the caller has to know which job.
 */
export async function hire(options: HireOptions): Promise<HireResult> {
  const { client, a2a, profile, capability, input } = options;
  const taskTimeoutMs = options.taskTimeoutMs ?? 50_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const refuse = (message: string): never => {
    throw new HireRefusedError(message, "before-funding");
  };

  if (profile.deactivated) refuse(`${profile.did} is deactivated`);
  const endpoint = profile.a2aEndpoint;
  if (endpoint === undefined) return refuse(`${profile.did} advertises no A2A endpoint`);
  const offered = profile.capabilities.find((c) => c.id === capability);
  if (!offered) {
    const ids = profile.capabilities.map((c) => c.id);
    return refuse(`${profile.name || profile.did} does not offer ${capability}; it offers ${ids.length ? ids.join(", ") : "nothing"}`);
  }
  // A job to carry on with: this wallet's, still Open, for this agent.
  let resumed: { jobId: bigint; budget: bigint } | undefined;
  if (options.jobId !== undefined) {
    let record;
    try {
      record = await client.getJobRecord(options.jobId);
    } catch (error) {
      return refuse(`job ${options.jobId} could not be read: ${messageOf(error)}`);
    }
    if (record.status !== JobStatus.Open) return refuse(`job ${options.jobId} is ${JOB_STATUS_NAMES[record.status as JobStatusValue] ?? record.status}, not Open; only an Open job can be carried on with`);
    if (!isAddressEqual(record.client, client.account)) return refuse(`job ${options.jobId} belongs to ${record.client}, not this wallet`);
    if (!isAddressEqual(record.provider, profile.provider)) return refuse(`job ${options.jobId} is for provider ${record.provider}, not ${profile.name || profile.did}'s ${profile.provider}`);
    resumed = { jobId: options.jobId, budget: record.budget };
  }
  const price = options.budget ?? (resumed !== undefined && resumed.budget > 0n ? formatUnits(resumed.budget, 6) : offered.price);
  if (price === undefined) return refuse(`${capability} has no price on the card; pass budget`);
  const amount = parseUnits(price, 6);
  if (amount <= 0n) return refuse("budget must be above zero");
  if (offered.price !== undefined && amount < parseUnits(offered.price, 6)) {
    return refuse(`budget ${price} is below the price of ${capability}, ${offered.price} USDC; the agent would refuse the task`);
  }
  const balance = await client.usdcBalance(client.account);
  if (balance < amount) return refuse(`the wallet holds ${formatUnits(balance, 6)} USDC; the job needs ${price}`);
  const horizon = await client.settlementHorizon();
  const days = options.expiresInDays ?? Math.max(options.jobDays ?? 7, Math.ceil((horizon + DAY) / DAY));
  const seconds = days * DAY;
  if (seconds < horizon + HOUR) {
    return refuse(
      `expiresInDays must be at least ${Math.ceil((horizon + HOUR) / DAY)}: the agent's submit needs the settlement horizon ` +
        `(${Math.round(horizon / HOUR)} h) ahead of the job's expiry`,
    );
  }
  // On a stack whose hook holds a module, a release to a client with no
  // policy on the registry is refused for certain (`policy commitment`),
  // and the provider is paid nothing for work it did (square#350). The
  // module and the commitment are read before any money moves.
  if ((await client.complianceModule()) !== null && (await client.policyOf(client.account)).commitment === ZERO32) {
    return refuse(
      `this wallet has no policy on the registry and the stack gates releases: the agent would work and the release would be refused. ` +
        "Commit a policy first (square policy commit)",
    );
  }
  const denied = await options.admit?.(amount);
  if (denied !== undefined) return refuse(denied);

  const transactions: Partial<HireTransactions> = {};
  let jobId: bigint;
  try {
    if (resumed !== undefined) {
      jobId = resumed.jobId;
      if (resumed.budget !== amount) transactions.setBudget = (await client.setBudget(jobId, amount)).hash;
    } else {
      // From the chain's clock, not this machine's: `createJob` holds
      // `expiredAt` against `block.timestamp`, and on a local chain whose
      // time has been advanced the two are days apart.
      const { timestamp } = await client.publicClient.getBlock();
      const created = await client.createJob({
        provider: profile.provider,
        expiredAt: timestamp + BigInt(seconds),
        spec: { agent: profile.did, capability, input },
      });
      jobId = created.jobId;
      transactions.createJob = created.hash;
      transactions.setBudget = (await client.setBudget(jobId, amount)).hash;
    }
    transactions.fund = (await client.fund(jobId, amount)).hash;
  } catch (error) {
    // square#368: the hook screens and a party has no fresh, clean record.
    // Nothing was sent; the job is Open with its budget set, and the same
    // hire completes it once the party is cleared.
    if (error instanceof PartyNotClearedError) {
      throw new HireRefusedError(
        `job ${error.jobId} was not funded: the ${error.role} ${error.subject} is ${error.state}, ${error.detail}; ` +
          `the job stays Open with its budget set and this wallet keeps its USDC. ` +
          (error.state === "sanctioned" ? "Hire another agent." : `Once the ${error.role} is screened, hire again with jobId ${error.jobId} to fund it.`),
        "funding",
        transactions,
      );
    }
    throw new HireRefusedError(`the job could not be funded: ${messageOf(error)}`, "funding", transactions);
  }
  await options.onFunded?.({ jobId, budget: amount, provider: profile.provider });

  const taskId = `square-job-${jobId}`;
  const result: HireResult = {
    jobId,
    taskId,
    budget: amount,
    provider: profile.provider,
    transactions: transactions as HireTransactions,
    dispatch: "undispatched",
  };
  // The escrow is on the job whatever A2A answers, so an endpoint that does
  // not answer the first time is asked once more before the hire comes back
  // undispatched (square#351); after that, `dispatch` is the way to try
  // again without opening another job.
  const outcome = await dispatch({ a2a, endpoint, taskId, capability, input, callerDid: options.callerDid, jobId, taskTimeoutMs, pollIntervalMs, redispatchDelayMs: options.redispatchDelayMs });
  result.dispatch = outcome.dispatch;
  if (outcome.task !== undefined) result.task = outcome.task;
  if (outcome.reason !== undefined) result.reason = outcome.reason;
  return result;
}

export interface DispatchOptions {
  a2a: A2AClient;
  endpoint: string;
  taskId: string;
  capability: string;
  input: string;
  callerDid: string;
  jobId: bigint;
  taskTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  /** How long to wait before the one automatic second attempt. Default 1 s. */
  redispatchDelayMs?: number | undefined;
  /** Whether to make that second attempt at all. Default true. */
  retry?: boolean | undefined;
}

export type DispatchOutcome = Pick<HireResult, "dispatch" | "task" | "reason">;

/**
 * `task/create` at the agent for a job that is already funded, then polling
 * until the task ends or the wait runs out: the second half of `hire`, on
 * its own so a task the first attempt could not hand over can be handed
 * over later (square#351). The task id is the job's, `square-job-<id>`, so
 * an agent that already holds the task answers with where it stands rather
 * than starting it twice.
 */
export async function dispatch(options: DispatchOptions): Promise<DispatchOutcome> {
  const taskTimeoutMs = options.taskTimeoutMs ?? 50_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const attempt = async (): Promise<{ outcome: DispatchOutcome; transient: boolean }> => {
    try {
      const task = await options.a2a.runTask(
        options.endpoint,
        { taskId: options.taskId, capability: options.capability, input: options.input, callerDid: options.callerDid, jobId: options.jobId.toString() },
        { pollIntervalMs, maxPolls: Math.max(1, Math.floor(taskTimeoutMs / pollIntervalMs)) },
      );
      if (task.state === TaskState.Failed) return { outcome: { dispatch: "failed", task, ...(task.reason !== undefined ? { reason: task.reason } : {}) }, transient: false };
      return { outcome: { dispatch: task.state === TaskState.Delivered ? "delivered" : "working", task }, transient: false };
    } catch (error) {
      if (error instanceof A2AError && error.kind === "timeout") return { outcome: { dispatch: "working" }, transient: false };
      // An endpoint that could not be reached, was busy or answered 5xx may
      // answer in a moment; an agent that refused the task (a JSON-RPC error)
      // will refuse it again, and is not asked twice.
      const transient =
        error instanceof A2AError &&
        (error.kind === "unreachable" || error.kind === "busy" || error.kind === "at-capacity" || (error.kind === "provider-error" && error.status !== undefined && error.status >= 500));
      return { outcome: { dispatch: "undispatched", reason: messageOf(error) }, transient };
    }
  };
  const first = await attempt();
  if (first.outcome.dispatch !== "undispatched" || !first.transient || options.retry === false) return first.outcome;
  await new Promise((resolve) => setTimeout(resolve, options.redispatchDelayMs ?? 1_000));
  const second = await attempt();
  if (second.outcome.dispatch === "undispatched") return { dispatch: "undispatched", reason: `${second.outcome.reason ?? "no answer"} (asked twice)` };
  return second.outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
