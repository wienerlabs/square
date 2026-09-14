import { A2AClient, A2AError, TaskState, type TaskStatusResult } from "@squaresdk/a2a";
import type { SquareClient } from "@squaresdk/core";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import type { AgentProfile } from "./agents.js";

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
  const price = options.budget ?? offered.price;
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
  const denied = await options.admit?.(amount);
  if (denied !== undefined) return refuse(denied);

  const transactions: Partial<HireTransactions> = {};
  let jobId: bigint;
  try {
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
    transactions.fund = (await client.fund(jobId, amount)).hash;
  } catch (error) {
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
  try {
    const task = await a2a.runTask(
      endpoint,
      { taskId, capability, input, callerDid: options.callerDid, jobId: jobId.toString() },
      { pollIntervalMs, maxPolls: Math.max(1, Math.floor(taskTimeoutMs / pollIntervalMs)) },
    );
    result.task = task;
    if (task.state === TaskState.Failed) {
      result.dispatch = "failed";
      if (task.reason !== undefined) result.reason = task.reason;
    } else {
      result.dispatch = task.state === TaskState.Delivered ? "delivered" : "working";
    }
  } catch (error) {
    if (error instanceof A2AError && error.kind === "timeout") {
      result.dispatch = "working";
    } else {
      result.dispatch = "undispatched";
      result.reason = messageOf(error);
    }
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
