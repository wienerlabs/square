import { JobStatus, type SquareClient } from "@squaresdk/core";
import type { Address, Hex } from "viem";
import type { Policy } from "./policy.js";
import type { Prover, ViolatedRule } from "./prover.js";
import { bindComplianceProof, moduleVerdict, proofState, releaseFacts, type BindOutcome, type ProofState, type ReleaseFacts } from "./release.js";

/**
 * The institution's release duty.
 *
 * A proof binds to the payee, the net, the day's counter and the clock as
 * they stand at release, and `finalize` is permissionless and paid: whoever
 * cranks first releases, and a job whose proof is missing or stale at that
 * moment is refused, which pays the client and not the provider. So the
 * proof cannot be a step of funding; it is kept current on every job the
 * institution has open, and once a window closes the duty releases the job
 * itself rather than waiting for a keeper to find it with the proof it just
 * bound (docs/decisions/proof-freshness.md).
 *
 * One instance per paying wallet. `track` a job when it is funded, `tick`
 * on a cadence well inside the module's tolerance, and read what happened
 * from the events. The keeper and the duty may both crank a job; whichever
 * lands second reverts and reads the chain, and the escrow moves once.
 */
export interface DutyOptions {
  client: SquareClient;
  policy: Policy;
  prover: Prover;
  /**
   * How old a bound proof may grow before it is rebuilt, in seconds. The
   * default is half the module's timestamp tolerance, read once, so a proof
   * checked current at one tick is still inside the tolerance at the next.
   */
  refreshAfterSeconds?: bigint | undefined;
  /** Crank a tracked job once its window has closed. Default true. */
  finalize?: boolean | undefined;
  onEvent?: ((event: DutyEvent) => void) | undefined;
  /**
   * Runs each tick of `run` through the caller's queue. The duty signs from
   * the same wallet as the hires it watches, and two transactions signed
   * from one wallet in the same instant can take the same nonce; a host that
   * serializes its hires hands the duty the same queue.
   */
  serialize?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
}

export type DutyEvent =
  | { type: "no-module" }
  | { type: "bound"; jobId: bigint; transaction: Hex; because: string[] }
  | { type: "refused"; jobId: bigint; reason: Exclude<BindOutcome, { bound: true }>["reason"]; detail: string; violated?: ViolatedRule[] | null }
  | { type: "released"; jobId: bigint; transaction: Hex; verified: boolean | null; payee: Address; amount: bigint; refusedFor?: Hex | undefined }
  | { type: "settled"; jobId: bigint; status: number }
  | { type: "error"; jobId: bigint | null; error: Error };

export interface TrackedJob {
  jobId: bigint;
  category: string;
  /** The last refusal reported for it, so the same one is not reported every tick. */
  lastRefusal?: string | undefined;
}

export interface TickReport {
  /** Jobs whose proof was (re)bound this tick. */
  bound: bigint[];
  /** Jobs whose proof was already current. */
  current: bigint[];
  /** Jobs the duty released this tick. */
  released: bigint[];
  /** Jobs that left Funded/Submitted by another hand, and are no longer tracked. */
  settled: bigint[];
  /** Jobs the proof could not be bound for, with why. */
  refused: { jobId: bigint; reason: string }[];
  errors: { jobId: bigint | null; error: Error }[];
}

const TERMINAL = new Set<number>([JobStatus.Completed, JobStatus.Rejected, JobStatus.Expired]);

export class ComplianceDuty {
  private readonly tracked = new Map<string, TrackedJob>();
  private refreshAfter: bigint | undefined;
  private saidNoModule = false;

  constructor(private readonly options: DutyOptions) {
    this.refreshAfter = options.refreshAfterSeconds;
  }

  /** Watch a job this wallet is the client of; `category` is the capability it bought. */
  track(jobId: bigint, category: string): void {
    const key = jobId.toString();
    if (!this.tracked.has(key)) this.tracked.set(key, { jobId, category });
  }

  untrack(jobId: bigint): void {
    this.tracked.delete(jobId.toString());
  }

  jobs(): TrackedJob[] {
    return [...this.tracked.values()];
  }

  private emit(event: DutyEvent): void {
    this.options.onEvent?.(event);
  }

  /** One pass over every tracked job. Never throws for one job's sake; errors are in the report. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { bound: [], current: [], released: [], settled: [], refused: [], errors: [] };
    if (this.tracked.size === 0) return report;
    const { client } = this.options;
    let module: Address | null;
    try {
      module = await client.complianceModule();
    } catch (error) {
      report.errors.push({ jobId: null, error: error instanceof Error ? error : new Error(String(error)) });
      this.emit({ type: "error", jobId: null, error: report.errors[0]!.error });
      return report;
    }
    if (module === null) {
      // Nothing gates a release on this stack; the keeper settles these jobs
      // as it settles every other, and there is no proof to keep.
      if (!this.saidNoModule) {
        this.saidNoModule = true;
        this.emit({ type: "no-module" });
      }
      return report;
    }
    if (this.refreshAfter === undefined) {
      const tolerance = (await client.complianceTolerance()) ?? 0n;
      this.refreshAfter = tolerance / 2n;
    }
    for (const job of [...this.tracked.values()]) {
      try {
        await this.attend(job, module, report);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        report.errors.push({ jobId: job.jobId, error: failure });
        this.emit({ type: "error", jobId: job.jobId, error: failure });
      }
    }
    return report;
  }

  private async attend(job: TrackedJob, module: Address, report: TickReport): Promise<void> {
    const { client, policy, prover } = this.options;
    let facts = await releaseFacts(client, job.jobId);
    if (TERMINAL.has(facts.status) || facts.status === JobStatus.Open) {
      this.settled(job, facts.status, report);
      return;
    }
    const bound = await client.complianceProofOf(job.jobId);
    let state: ProofState = proofState(bound, facts, this.refreshAfter ?? 0n);
    if (state.kind !== "current") {
      const because = state.kind === "stale" ? state.reasons : [state.kind === "none" ? "no proof is bound" : "the bound proof is malformed"];
      const outcome = await bindComplianceProof({ client, policy, prover, jobId: job.jobId, category: job.category, facts });
      if (!outcome.bound) {
        const detail = outcome.reason === "not-compliant" ? `not compliant: ${(outcome.violated ?? ["rules unknown"]).join(", ")}` : outcome.detail;
        report.refused.push({ jobId: job.jobId, reason: `${outcome.reason}: ${detail}` });
        if (job.lastRefusal !== detail) {
          job.lastRefusal = detail;
          this.emit({ type: "refused", jobId: job.jobId, reason: outcome.reason, detail, ...(outcome.reason === "not-compliant" ? { violated: outcome.violated } : {}) });
        }
        if (outcome.reason === "terminal") this.settled(job, facts.status, report);
        return;
      }
      job.lastRefusal = undefined;
      report.bound.push(job.jobId);
      this.emit({ type: "bound", jobId: job.jobId, transaction: outcome.transaction, because });
      // The binding took a block; what the release binds to may have moved.
      facts = await releaseFacts(client, job.jobId);
      state = proofState(outcome.proof, facts, this.refreshAfter ?? 0n);
    } else {
      report.current.push(job.jobId);
    }
    if (this.options.finalize === false) return;
    if (facts.status !== JobStatus.Submitted) return;
    // Optimistic: the window has to have closed. Disputed: the arbiters have
    // to have decided, and `finalizeDecided` applies what they decided; an
    // open dispute is nobody's to crank.
    if (facts.disputed ? facts.providerBps === null : facts.challengeEnd === null || facts.challengeEnd > facts.now) return;
    if (state.kind !== "current") return; // rebound and moved again; next tick
    try {
      const result = facts.disputed ? await client.finalizeDecided(job.jobId) : await client.finalize(job.jobId);
      const verdict = moduleVerdict(result.receipt, module);
      report.released.push(job.jobId);
      this.emit({
        type: "released",
        jobId: job.jobId,
        transaction: result.hash,
        verified: verdict === null ? null : verdict.verified,
        payee: facts.payee,
        amount: facts.amount,
        refusedFor: verdict?.reason,
      });
      this.untrack(job.jobId);
    } catch (error) {
      // Somebody else may have cranked it between the read and the send.
      const record = await client.getJobRecord(job.jobId);
      if (TERMINAL.has(record.status)) {
        this.settled(job, record.status, report);
        return;
      }
      throw error;
    }
  }

  private settled(job: TrackedJob, status: number, report: TickReport): void {
    this.untrack(job.jobId);
    report.settled.push(job.jobId);
    this.emit({ type: "settled", jobId: job.jobId, status });
  }

  /** Tick until the signal aborts. The interval should sit well inside the module's tolerance. */
  async run(signal: AbortSignal, options: { intervalMs?: number | undefined } = {}): Promise<void> {
    const intervalMs = options.intervalMs ?? 15_000;
    const serialize = this.options.serialize;
    while (!signal.aborted) {
      await (serialize ? serialize(() => this.tick()) : this.tick());
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, intervalMs);
        function done(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

export type { ReleaseFacts };
