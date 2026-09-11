import type { Hex } from "viem";
import { JobStatus, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { disputes, jobs, keeperActions, type Database } from "@squaresdk/data";
import type { Logger, Metrics } from "@squaresdk/observability";
import {
  decide,
  expiryIsNear,
  EXPIRY_WARNING_SECONDS,
  gasCostInUsdc,
  keeperFee,
  oldestPendingAge,
  type KeeperCandidate,
  type KeeperEconomics,
} from "./decide.js";
import type { PayeeScreening } from "./screening.js";

export interface KeeperRetryPolicy {
  baseDelaySeconds: bigint;
  maxDelaySeconds: bigint;
  giveUpAfter: number;
  maxJournalRowsPerJob: number;
}

export const DEFAULT_EXPIRY_BATCH_SIZE = 25;
export const DEFAULT_EXPIRY_INTERVAL_MS = 60_000;

export const DEFAULT_RETRY_POLICY: KeeperRetryPolicy = {
  baseDelaySeconds: 60n,
  maxDelaySeconds: 3_600n,
  giveUpAfter: 6,
  maxJournalRowsPerJob: 3,
};

export interface KeeperOptions {
  db: Database;
  chainId: number;
  client: SquareClient;
  logger: Logger;
  metrics?: Metrics;
  minimumMarginBps: number;
  defaultFinalizeGas: bigint;
  defaultFinalizeDecidedGas: bigint;
  recordExpiries: boolean;
  expiryBatchSize?: number;
  expiryIntervalMs?: number;
  ephemeralMirror?: boolean;
  retryPolicy?: KeeperRetryPolicy;
  complianceProofFor?: (jobId: bigint) => Promise<Hex>;
  /**
   * square#35. Asked before every finalize: whether the payee is cleared by the
   * job's screening registry, after asking the screener for a fresh screening.
   * When it says not to proceed the job is held, not refused (payeeScreening).
   */
  screenPayee?: (jobId: bigint) => Promise<PayeeScreening>;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: bigint;
  gaveUp: boolean;
  journaled: Set<string>;
}

export interface TickReport {
  finalized: bigint[];
  applied: bigint[];
  lapsed: bigint[];
  skipped: Array<{ jobId: bigint; reason: string }>;
  nearExpiry: bigint[];
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface ExpirySweepReport {
  scanned: number;
  recorded: bigint[];
  alreadyRecorded: bigint[];
  failed: bigint[];
}

function usdc(amount: bigint): number {
  return Number(amount) / 1_000_000;
}

export class Keeper {
  private readonly journaledSkips = new Set<string>();
  private readonly warnedNearExpiry = new Set<string>();
  private readonly retries = new Map<string, RetryState>();

  constructor(private readonly options: KeeperOptions) {}

  private get retryPolicy(): KeeperRetryPolicy {
    return this.options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  private get expiryBatchSize(): number {
    return this.options.expiryBatchSize ?? DEFAULT_EXPIRY_BATCH_SIZE;
  }

  private get expiryIntervalMs(): number {
    return this.options.expiryIntervalMs ?? DEFAULT_EXPIRY_INTERVAL_MS;
  }

  private backoffSeconds(attempts: number): bigint {
    const policy = this.retryPolicy;
    const scaled = policy.baseDelaySeconds << BigInt(Math.max(0, attempts - 1));
    return scaled > policy.maxDelaySeconds ? policy.maxDelaySeconds : scaled;
  }

  private retryOf(jobId: bigint): RetryState | undefined {
    return this.retries.get(jobId.toString());
  }

  private async noteFailure(jobId: bigint, action: "finalize" | "finalizeDecided" | "lapse", message: string, now: bigint): Promise<boolean> {
    const { db, chainId, logger, metrics } = this.options;
    const policy = this.retryPolicy;
    const key = jobId.toString();
    const state = this.retries.get(key) ?? { attempts: 0, nextAttemptAt: now, gaveUp: false, journaled: new Set<string>() };
    state.attempts += 1;
    state.gaveUp = state.attempts >= policy.giveUpAfter;
    const delay = this.backoffSeconds(state.attempts);
    state.nextAttemptAt = now + delay;
    this.retries.set(key, state);

    const marker = state.gaveUp ? "gaveUp" : message.slice(0, 120);
    if (!state.journaled.has(marker) && (state.gaveUp || state.journaled.size < policy.maxJournalRowsPerJob)) {
      state.journaled.add(marker);
      const reason = state.gaveUp ? `gave up after ${state.attempts} attempts: ${message}`.slice(0, 200) : message.slice(0, 200);
      await keeperActions.append(db, { chainId, jobId, action, reason });
    }
    metrics?.recordKeeperAction(action, "failure");
    if (state.gaveUp) {
      logger.error("keeper.gave_up", { jobId: key, attempts: state.attempts, error: message });
    } else {
      logger.error("keeper.finalize_failed", { jobId: key, attempts: state.attempts, retryInSeconds: Number(delay), error: message });
    }
    return state.gaveUp;
  }

  private async economics(): Promise<KeeperEconomics> {
    const gasPriceWei = await this.options.client.publicClient.getGasPrice();
    return {
      gasPriceWei,
      finalizeGas: this.options.defaultFinalizeGas,
      finalizeDecidedGas: this.options.defaultFinalizeDecidedGas,
      minimumMarginBps: this.options.minimumMarginBps,
    };
  }

  private async candidateFromChain(jobId: bigint): Promise<KeeperCandidate | null> {
    const { client } = this.options;
    const record = await client.getJobRecord(jobId);
    if (record.status !== JobStatus.Submitted) return null;
    const disputed = await client.isDisputed(jobId);
    let decidedOutcome: number | null = null;
    let resolveBy: bigint | null = null;
    if (disputed) {
      const dispute = await client.disputeOf(jobId);
      decidedOutcome = dispute.outcome;
      resolveBy = BigInt(dispute.resolveBy);
    }
    const challengeEnd = await client.challengeEndsAt(jobId);
    return {
      jobId,
      status: record.status,
      disputed,
      challengeEnd: BigInt(challengeEnd),
      budget: record.budget,
      evaluatorFeeBP: record.evaluatorFeeBP,
      decidedOutcome,
      resolveBy,
      expiredAt: BigInt(record.expiredAt),
    };
  }

  async tick(now = BigInt(Math.floor(Date.now() / 1000))): Promise<TickReport> {
    const { db, chainId, client, logger, metrics } = this.options;
    const report: TickReport = { finalized: [], applied: [], lapsed: [], skipped: [], nearExpiry: [], pending: 0, oldestPendingAgeSeconds: 0 };
    const economics = await this.economics();
    const evaluator = client.deployment.keeperEvaluator;
    const mirrored = [
      ...(await jobs.listFinalizable(db, chainId, now, evaluator)),
      ...(await jobs.listDisputedSubmitted(db, chainId, evaluator)),
    ];
    if (this.options.ephemeralMirror === true && mirrored.length === 0) {
      logger.warn("keeper.empty_mirror", {
        reason: "DATABASE_URL is not set, so this keeper reads a private in-memory mirror that no indexer writes to and it will never find a candidate",
      });
    }
    const confirmed: KeeperCandidate[] = [];
    for (const row of mirrored) {
      const candidate = await this.candidateFromChain(row.jobId);
      if (candidate) confirmed.push(candidate);
    }
    report.pending = confirmed.filter((c) => !c.disputed && c.challengeEnd !== null && now >= c.challengeEnd).length;
    report.oldestPendingAgeSeconds = Number(oldestPendingAge(confirmed, now));
    metrics?.setFinalizePending(report.pending);
    metrics?.setOldestPendingAgeSeconds(report.oldestPendingAgeSeconds);
    metrics?.setDisputesOpen((await disputes.listOpen(db, chainId)).length);
    this.forgetJobsThatLeft(confirmed);

    for (const candidate of confirmed) {
      if (expiryIsNear(candidate, now)) {
        report.nearExpiry.push(candidate.jobId);
        this.warnOnceOnNearExpiry(candidate, now);
      }
      const action = decide(candidate, now, economics);
      if (action.kind !== "skip") {
        const retry = this.retryOf(candidate.jobId);
        if (retry?.gaveUp === true) {
          report.skipped.push({ jobId: candidate.jobId, reason: "gaveUp" });
          continue;
        }
        if (retry !== undefined && now < retry.nextAttemptAt) {
          report.skipped.push({ jobId: candidate.jobId, reason: "backoff" });
          continue;
        }
      }
      if (action.kind === "lapse") {
        try {
          const result = await client.lapse(candidate.jobId);
          await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: "lapse", txHash: result.hash, gasUsed: result.receipt.gasUsed });
          metrics?.recordKeeperAction("lapse", "success");
          this.retries.delete(candidate.jobId.toString());
          report.lapsed.push(candidate.jobId);
          logger.info("keeper.lapsed", { jobId: candidate.jobId.toString(), txHash: result.hash });
        } catch (error) {
          await this.noteFailure(candidate.jobId, "lapse", error instanceof Error ? error.message : String(error), now);
        }
        continue;
      }
      if (action.kind === "skip") {
        report.skipped.push({ jobId: candidate.jobId, reason: action.reason });
        if (action.reason === "unprofitable" && !this.journaledSkips.has(candidate.jobId.toString())) {
          this.journaledSkips.add(candidate.jobId.toString());
          await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: "skipped", reason: action.reason });
          metrics?.recordKeeperAction("finalize", "skipped");
          logger.info("keeper.skipped", {
            jobId: candidate.jobId.toString(),
            reason: action.reason,
            fee: usdc(keeperFee(candidate.budget, candidate.evaluatorFeeBP ?? 0)),
            gasUsed: Number(gasCostInUsdc(economics.gasPriceWei, economics.finalizeGas)),
          });
        }
        continue;
      }
      if (this.options.screenPayee) {
        const screening = await this.options.screenPayee(candidate.jobId);
        if (!screening.proceed) {
          report.skipped.push({ jobId: candidate.jobId, reason: "unscreened" });
          logger.warn("keeper.held", {
            jobId: candidate.jobId.toString(),
            reason: "the payee is not cleared and no fresh screening could be had; finalizing now would refuse the release",
          });
          continue;
        }
        if (screening.state === "sanctioned") {
          logger.warn("keeper.refusing", {
            jobId: candidate.jobId.toString(),
            reason: "a fresh screening says the payee is designated; the release goes back to the client",
          });
        }
      }
      const proof = this.options.complianceProofFor ? await this.options.complianceProofFor(candidate.jobId) : "0x";
      try {
        const result = action.kind === "finalize" ? await client.finalize(candidate.jobId, proof) : await client.finalizeDecided(candidate.jobId, proof);
        const paid = result.events.find((e) => e.contract === "KeeperEvaluator" && (e.eventName === "Finalized" || e.eventName === "DecisionApplied"));
        const fee = paid && "keeperFee" in paid.args ? (paid.args.keeperFee as bigint) : 0n;
        await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: action.kind, txHash: result.hash, gasUsed: result.receipt.gasUsed, feeEarned: fee });
        metrics?.recordKeeperAction(action.kind, "success");
        metrics?.addKeeperFeeUsdc(usdc(fee));
        metrics?.recordFinalizeGas(
          action.kind,
          action.kind === "finalize" ? economics.finalizeGas : economics.finalizeDecidedGas,
          result.receipt.gasUsed,
        );
        this.retries.delete(candidate.jobId.toString());
        (action.kind === "finalize" ? report.finalized : report.applied).push(candidate.jobId);
        logger.info("keeper.finalized", { jobId: candidate.jobId.toString(), txHash: result.hash, gasUsed: Number(result.receipt.gasUsed), fee: usdc(fee) });
      } catch (error) {
        await this.noteFailure(candidate.jobId, action.kind, error instanceof Error ? error.message : String(error), now);
      }
    }

    metrics?.recordKeeperTick();
    return report;
  }

  private forgetJobsThatLeft(confirmed: KeeperCandidate[]): void {
    const present = new Set(confirmed.map((candidate) => candidate.jobId.toString()));
    for (const key of this.warnedNearExpiry) {
      if (!present.has(key)) this.warnedNearExpiry.delete(key);
    }
  }

  private warnOnceOnNearExpiry(candidate: KeeperCandidate, now: bigint): void {
    const key = candidate.jobId.toString();
    if (this.warnedNearExpiry.has(key)) return;
    this.warnedNearExpiry.add(key);
    const left = (candidate.expiredAt ?? 0n) - now;
    this.options.logger.warn("keeper.expiry_near", {
      jobId: key,
      reason: `expires in ${left}s, inside the ${EXPIRY_WARNING_SECONDS}s warning window`,
    });
  }

  async sweepExpiries(): Promise<ExpirySweepReport> {
    const { db, chainId, client, logger, metrics } = this.options;
    const report: ExpirySweepReport = { scanned: 0, recorded: [], alreadyRecorded: [], failed: [] };
    const rows = await jobs.listExpiredWithAgent(db, chainId, client.deployment.keeperEvaluator, this.expiryBatchSize);
    report.scanned = rows.length;
    for (const row of rows) {
      const recorded = await client.publicClient.readContract({
        abi: squareHookAbi,
        address: client.deployment.squareHook,
        functionName: "recorded",
        args: [row.jobId],
      });
      if (recorded) {
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "recordExpiry" });
        report.alreadyRecorded.push(row.jobId);
        logger.info("keeper.expiry_already_recorded", {
          jobId: row.jobId.toString(),
          reason: "the hook already carries this expiry, journaled so the sweep stops asking the chain about it",
        });
        continue;
      }
      try {
        const result = await client.recordExpiry(row.jobId);
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "recordExpiry", txHash: result.hash, gasUsed: result.receipt.gasUsed });
        metrics?.recordKeeperAction("recordExpiry", "success");
        report.recorded.push(row.jobId);
      } catch (error) {
        report.failed.push(row.jobId);
        metrics?.recordKeeperAction("recordExpiry", "failure");
        logger.warn("keeper.record_expiry_failed", { jobId: row.jobId.toString(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  async run(pollIntervalMs: number, signal: AbortSignal): Promise<void> {
    let nextExpirySweepAt = 0;
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.options.logger.error("keeper.tick_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (this.options.recordExpiries && Date.now() >= nextExpirySweepAt) {
        try {
          await this.sweepExpiries();
        } catch (error) {
          this.options.logger.error("keeper.expiry_sweep_failed", { error: error instanceof Error ? error.message : String(error) });
        }
        nextExpirySweepAt = Date.now() + this.expiryIntervalMs;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
