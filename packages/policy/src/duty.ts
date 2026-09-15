import { JobStatus, squareJobAbi, type SquareClient } from "@squaresdk/core";
import { formatUnits, getAbiItem, type Address, type Hex } from "viem";
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
 * proof is bound when a release is about to be possible, and once a window
 * closes the duty releases the job itself rather than waiting for a keeper
 * to find it with the proof it just bound (docs/decisions/proof-freshness.md).
 *
 * The proof is bound to the release, not to the calendar (square#349). A
 * `Funded` job cannot be released, so nothing is bound to it; a `Submitted`
 * job's window is a day, so a proof bound at submit would be stale by the
 * close and rebound every half tolerance in between, 48 transactions a day
 * for nothing. The duty waits until the close is within `refreshAfter`, binds
 * once, and cranks when the window closes: one bind and one finalize per
 * job on the ordinary path. A decided dispute is the same at the decision.
 *
 * One instance per paying wallet. `track` a job when it is funded, `tick`
 * on a cadence well inside the module's tolerance, and read what happened
 * from the events. The keeper and the duty may both crank a job; whichever
 * lands second reverts and reads the chain, and the escrow moves once.
 *
 * The jobs outlive the process (square#348): a window is a day and a
 * server restarts more often than that. With a `state` the tracked jobs are
 * written on every change and read back by `recover`, which `run` calls
 * first; and whatever the file does not hold, `recover` finds on the chain,
 * in this wallet's `JobCreated` logs, and tracks without a category until
 * the first proof tells which of the policy's categories the job bought.
 */
export interface DutyOptions {
  client: SquareClient;
  policy: Policy;
  prover: Prover;
  /**
   * How close to the release a proof is bound, and how old a bound proof may
   * grow before it is rebuilt, in seconds. The default is half the module's
   * timestamp tolerance, read on every tick so an owner's change to the
   * tolerance is seen at the next one.
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
  /** Where the tracked jobs are kept across restarts; `fileDutyState` from `@squaresdk/policy/node` is one. */
  state?: DutyState | undefined;
  /** Where `recover`'s scan of this wallet's `JobCreated` logs starts. Default: the deployment's `startBlock`, else 0. */
  discoverFromBlock?: bigint | undefined;
  /** Blocks per `eth_getLogs` in that scan; halved when the endpoint refuses the span. Default 10 000. */
  discoverBatchBlocks?: bigint | undefined;
  /** Whether `recover` scans the chain at all. Default true. */
  discover?: boolean | undefined;
}

/** The tracked jobs, kept somewhere a restart does not reach. */
export interface DutyState {
  load(): TrackedJob[] | Promise<TrackedJob[]>;
  save(jobs: TrackedJob[]): void | Promise<void>;
}

export type DutyEvent =
  | { type: "no-module" }
  | { type: "recovered"; restored: bigint[]; discovered: bigint[] }
  | { type: "bound"; jobId: bigint; transaction: Hex; because: string[] }
  | { type: "refused"; jobId: bigint; reason: Exclude<BindOutcome, { bound: true }>["reason"]; detail: string; violated?: ViolatedRule[] | null }
  | { type: "released"; jobId: bigint; transaction: Hex; verified: boolean | null; payee: Address; amount: bigint; refusedFor?: Hex | undefined }
  | { type: "settled"; jobId: bigint; status: number }
  | { type: "error"; jobId: bigint | null; error: Error };

export interface TrackedJob {
  jobId: bigint;
  /** The capability the job bought; undefined for a job recovered from the chain, until its first proof resolves it. */
  category: string | undefined;
  /** What the job was funded with, when the host told the duty; kept for an allowance that counts it. */
  budget?: bigint | undefined;
  /** The last refusal reported for it, so the same one is not reported every tick. */
  lastRefusal?: string | undefined;
}

export interface TickReport {
  /** Jobs whose proof was (re)bound this tick. */
  bound: bigint[];
  /** Jobs whose proof was already current. */
  current: bigint[];
  /** Jobs no release can happen to yet: Funded, a window with more than `refreshAfter` to run, an undecided dispute. Nothing is sent for them. */
  waiting: bigint[];
  /** Jobs the duty released this tick. */
  released: bigint[];
  /** Jobs that left Funded/Submitted by another hand, and are no longer tracked. */
  settled: bigint[];
  /** Jobs the proof could not be bound for, with why. */
  refused: { jobId: bigint; reason: string }[];
  errors: { jobId: bigint | null; error: Error }[];
}

const TERMINAL = new Set<number>([JobStatus.Completed, JobStatus.Rejected, JobStatus.Expired]);
const JOB_CREATED = getAbiItem({ abi: squareJobAbi, name: "JobCreated" });

export class ComplianceDuty {
  private readonly tracked = new Map<string, TrackedJob>();
  private saidNoModule = false;

  constructor(private readonly options: DutyOptions) {}

  /** Watch a job this wallet is the client of; `category` is the capability it bought, `budget` what it was funded with. */
  track(jobId: bigint, category: string | undefined, budget?: bigint): void {
    const key = jobId.toString();
    const known = this.tracked.get(key);
    if (known) {
      if (known.category === undefined && category !== undefined) known.category = category;
      if (known.budget === undefined && budget !== undefined) known.budget = budget;
    } else {
      this.tracked.set(key, { jobId, category, ...(budget !== undefined ? { budget } : {}) });
    }
    void this.persist();
  }

  untrack(jobId: bigint): void {
    if (this.tracked.delete(jobId.toString())) void this.persist();
  }

  jobs(): TrackedJob[] {
    return [...this.tracked.values()];
  }

  private emit(event: DutyEvent): void {
    this.options.onEvent?.(event);
  }

  /** Write the tracked jobs to the state, when there is one; a failure is reported, not thrown. */
  private async persist(): Promise<void> {
    const { state } = this.options;
    if (!state) return;
    try {
      await state.save(this.jobs());
    } catch (error) {
      this.emit({ type: "error", jobId: null, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  /**
   * What this process forgot: the jobs the state holds, and then the ones
   * the chain shows this wallet still has open. `run` calls it first. A job
   * the state knows keeps its category; one only the chain knows has none
   * until its first proof, and is tracked all the same, because a job with
   * no proof at the close is a job the provider is not paid for.
   */
  async recover(): Promise<{ restored: bigint[]; discovered: bigint[] }> {
    const restored: bigint[] = [];
    const { state } = this.options;
    if (state) {
      for (const job of await state.load()) {
        const key = job.jobId.toString();
        if (this.tracked.has(key)) continue;
        this.tracked.set(key, { jobId: job.jobId, category: job.category, ...(job.budget !== undefined ? { budget: job.budget } : {}) });
        restored.push(job.jobId);
      }
    }
    const discovered = this.options.discover === false ? [] : await this.discover();
    if (restored.length > 0 || discovered.length > 0) {
      this.emit({ type: "recovered", restored, discovered });
      await this.persist();
    }
    return { restored, discovered };
  }

  /** This wallet's `JobCreated` logs from the deployment onwards, and of those the jobs still Funded or Submitted. */
  private async discover(): Promise<bigint[]> {
    const { client } = this.options;
    const head = (await client.publicClient.getBlock({ blockTag: "latest" })).number;
    if (head === null) return [];
    let from = this.options.discoverFromBlock ?? client.deployment.startBlock ?? 0n;
    let batch = this.options.discoverBatchBlocks ?? 10_000n;
    const found: bigint[] = [];
    while (from <= head) {
      const to = from + batch - 1n < head ? from + batch - 1n : head;
      let logs: { args: { jobId?: bigint | undefined } }[];
      try {
        logs = await client.publicClient.getLogs({ address: client.deployment.squareJob, event: JOB_CREATED, args: { client: client.account }, fromBlock: from, toBlock: to });
      } catch (error) {
        // Arc refuses a span above a few tens of thousands of blocks; a
        // refused span is halved until it fits, the way the indexer does. An
        // endpoint that refuses a single block is refusing, not limiting.
        if (batch <= 1n) throw error;
        batch /= 2n;
        continue;
      }
      for (const log of logs) {
        const jobId = log.args.jobId;
        if (jobId === undefined || this.tracked.has(jobId.toString())) continue;
        const record = await client.getJobRecord(jobId);
        if (record.status !== JobStatus.Funded && record.status !== JobStatus.Submitted) continue;
        this.tracked.set(jobId.toString(), { jobId, category: undefined });
        found.push(jobId);
      }
      from = to + 1n;
    }
    return found;
  }

  /** One pass over every tracked job. Never throws for one job's sake; errors are in the report. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { bound: [], current: [], waiting: [], released: [], settled: [], refused: [], errors: [] };
    if (this.tracked.size === 0) return report;
    const { client } = this.options;
    let module: Address | null;
    let refreshAfter: bigint;
    try {
      module = await client.complianceModule();
      if (module === null) {
        // Nothing gates a release on this stack; the keeper settles these jobs
        // as it settles every other, and there is no proof to keep.
        if (!this.saidNoModule) {
          this.saidNoModule = true;
          this.emit({ type: "no-module" });
        }
        return report;
      }
      // Read every tick: the tolerance is the owner's to change, and a duty
      // that kept the old half would bind proofs the module no longer takes.
      refreshAfter = this.options.refreshAfterSeconds ?? ((await client.complianceTolerance()) ?? 0n) / 2n;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      report.errors.push({ jobId: null, error: failure });
      this.emit({ type: "error", jobId: null, error: failure });
      return report;
    }
    for (const job of [...this.tracked.values()]) {
      try {
        await this.attend(job, module, refreshAfter, report);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        report.errors.push({ jobId: job.jobId, error: failure });
        this.emit({ type: "error", jobId: job.jobId, error: failure });
      }
    }
    return report;
  }

  private async attend(job: TrackedJob, module: Address, refreshAfter: bigint, report: TickReport): Promise<void> {
    const { client, policy, prover } = this.options;
    let facts = await releaseFacts(client, job.jobId);
    if (TERMINAL.has(facts.status) || facts.status === JobStatus.Open) {
      this.settled(job, facts.status, report);
      return;
    }
    // Nothing is sent until a release is near enough that a proof bound now
    // is still current at it: a Funded job cannot be released; an optimistic
    // window is waited out to within refreshAfter of its close; an open
    // dispute is nobody's to crank until the arbiters have decided.
    if (facts.status !== JobStatus.Submitted || (facts.disputed ? facts.providerBps === null : facts.challengeEnd === null || facts.challengeEnd - facts.now > refreshAfter)) {
      report.waiting.push(job.jobId);
      return;
    }
    const bound = await client.complianceProofOf(job.jobId);
    let state: ProofState = proofState(bound, facts, refreshAfter);
    if (state.kind !== "current") {
      const because = state.kind === "stale" ? state.reasons : [state.kind === "none" ? "no proof is bound" : "the bound proof is malformed"];
      const outcome = await bindComplianceProof({ client, policy, prover, jobId: job.jobId, category: job.category, facts });
      if (job.category === undefined && "category" in outcome) {
        // The first proof of a recovered job says which category it bought,
        // whether or not the policy then allows the release.
        job.category = outcome.category;
        await this.persist();
      }
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
      state = proofState(outcome.proof, facts, refreshAfter);
    } else {
      report.current.push(job.jobId);
    }
    if (this.options.finalize === false) return;
    if (facts.status !== JobStatus.Submitted) return;
    // Optimistic: the window has to have closed. Disputed: the arbiters have
    // to have decided, and `finalizeDecided` applies what they decided.
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

  /** Recover what a restart forgot, then tick until the signal aborts. The interval should sit well inside the module's tolerance. */
  async run(signal: AbortSignal, options: { intervalMs?: number | undefined } = {}): Promise<void> {
    const intervalMs = options.intervalMs ?? 15_000;
    const serialize = this.options.serialize;
    try {
      await (serialize ? serialize(() => this.recover()) : this.recover());
    } catch (error) {
      this.emit({ type: "error", jobId: null, error: error instanceof Error ? error : new Error(String(error)) });
    }
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

/** One line per event, for a host's log; the CLI colours its own. */
export function describeDutyEvent(event: DutyEvent): string {
  switch (event.type) {
    case "no-module":
      return "the hook holds no compliance module; nothing to prove";
    case "recovered":
      return `recovered ${event.restored.length + event.discovered.length} job(s): ${event.restored.length} from the state, ${event.discovered.length} from the chain${event.discovered.length ? ` (${event.discovered.join(", ")})` : ""}`;
    case "bound":
      return `job ${event.jobId}: proof bound in ${event.transaction} (${event.because.join("; ")})`;
    case "refused":
      return `job ${event.jobId}: no proof bound, ${event.reason}: ${event.detail}`;
    case "released":
      return `job ${event.jobId}: released in ${event.transaction}, ${event.verified === false ? `refused by the module (${event.refusedFor ?? "reason unknown"})` : `${formatUnits(event.amount, 6)} USDC to ${event.payee}`}`;
    case "settled":
      return `job ${event.jobId}: settled by another hand (status ${event.status})`;
    case "error":
      return `${event.jobId === null ? "duty" : `job ${event.jobId}`}: ${event.error.message}`;
  }
}

export type { ReleaseFacts };
