import { JobStatus, type SquareClient } from "@squaresdk/core";
import { formatUnits, type Address } from "viem";

export interface AllowanceView {
  /** The registry has a policy for the poster. Without one, nothing may be delegated. */
  policy: boolean;
  /** USDC atomic units, all four. */
  dailyLimit: bigint;
  spentToday: bigint;
  /** Delegated jobs this wallet has funded that the chain has not settled or refunded. */
  inFlight: bigint;
  /** `dailyLimit - spentToday - inFlight`, floored at zero. */
  available: bigint;
}

export interface PolicyAllowanceOptions {
  /** The delegating wallet's client; its account is the poster whose policy applies. */
  client: SquareClient;
  /** The most one delegated job may be funded with. A slice of the allowance, not a second ceiling. */
  maxPerJob?: bigint | undefined;
}

const TERMINAL: ReadonlySet<number> = new Set([JobStatus.Completed, JobStatus.Rejected, JobStatus.Expired]);

/**
 * What a hosted agent may still delegate today, derived from the policy
 * the institution committed on chain (docs/decisions/delegation-allowance.md).
 *
 * There is one ceiling, `PolicyRegistry.dailyLimit`, keyed by the wallet
 * the agent delegates from, and one counter, `spentToday`, which the
 * registry advances when escrow is released to a provider. Neither is kept
 * here. What is kept is the set of delegated jobs this wallet has funded
 * and the chain has not yet settled: escrow moves at funding and the
 * counter at release, and between the two a job is money the ceiling has
 * to be read as already spoken for. Every view reads the registry again
 * and drops from the set whatever the chain now shows settled, so a
 * restart loses at most the reservation of jobs still in flight, never the
 * ceiling or the count; a host that must not lose even that passes the
 * job ids back in with `restore`.
 *
 * No policy is no allowance: the registry treats a zero commitment as
 * authorising nothing at release, and a delegation refused here for the
 * same reason is refused before any escrow moves.
 */
export class PolicyAllowance {
  private readonly client: SquareClient;
  private readonly maxPerJob: bigint | undefined;
  private readonly inFlight = new Map<bigint, bigint>();

  constructor(options: PolicyAllowanceOptions) {
    this.client = options.client;
    this.maxPerJob = options.maxPerJob;
  }

  get poster(): Address {
    return this.client.account;
  }

  /** The jobs counted as in flight, for a host that persists them. */
  inFlightJobs(): Array<{ jobId: bigint; budget: bigint }> {
    return [...this.inFlight.entries()].map(([jobId, budget]) => ({ jobId, budget }));
  }

  /** Jobs funded before this process started, read back from the chain on the next view. */
  restore(jobs: Iterable<{ jobId: bigint; budget: bigint }>): void {
    for (const job of jobs) this.inFlight.set(job.jobId, job.budget);
  }

  /** Record a job this wallet just funded. `hire` calls it through `onFunded`. */
  funded(job: { jobId: bigint; budget: bigint }): void {
    this.inFlight.set(job.jobId, job.budget);
  }

  /** The allowance as the chain has it now. */
  async view(): Promise<AllowanceView> {
    const poster = this.poster;
    const [policy, spentToday] = await Promise.all([this.client.policyOf(poster), this.client.spentToday(poster)]);
    await this.settle();
    let inFlight = 0n;
    for (const budget of this.inFlight.values()) inFlight += budget;
    const hasPolicy = policy.commitment !== `0x${"00".repeat(32)}`;
    const dailyLimit = hasPolicy ? policy.dailyLimit : 0n;
    const remaining = dailyLimit - spentToday - inFlight;
    return { policy: hasPolicy, dailyLimit, spentToday, inFlight, available: remaining > 0n ? remaining : 0n };
  }

  /**
   * Why an amount may not be delegated now, or undefined when it may. The
   * shape `hire` takes as `admit`.
   */
  async admit(amount: bigint): Promise<string | undefined> {
    if (this.maxPerJob !== undefined && amount > this.maxPerJob) {
      return `${usdc(amount)} USDC is more than one delegated job may be funded with (${usdc(this.maxPerJob)})`;
    }
    const view = await this.view();
    if (!view.policy) return `${this.poster} has no policy on the registry, so it may delegate nothing`;
    if (amount > view.available) {
      return (
        `${usdc(amount)} USDC is more than the policy allows today: ceiling ${usdc(view.dailyLimit)}, ` +
        `${usdc(view.spentToday)} released today, ${usdc(view.inFlight)} in flight on ${this.inFlight.size} job(s), ${usdc(view.available)} available`
      );
    }
    return undefined;
  }

  /** Drop the jobs the chain shows settled: released, refunded or expired. */
  private async settle(): Promise<void> {
    for (const jobId of [...this.inFlight.keys()]) {
      const record = await this.client.getJobRecord(jobId);
      if (TERMINAL.has(record.status)) this.inFlight.delete(jobId);
    }
  }
}

function usdc(amount: bigint): string {
  return formatUnits(amount, 6);
}
