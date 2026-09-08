import type { Hex } from "viem";
import { JobStatus, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { disputes, jobs, keeperActions, type Database } from "@squaresdk/data";
import type { Logger, Metrics } from "@squaresdk/observability";
import { decide, expiryIsNear, gasCostInUsdc, keeperFee, oldestPendingAge, type KeeperCandidate, type KeeperEconomics } from "./decide.js";

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
  complianceProofFor?: (jobId: bigint) => Promise<Hex>;
}

export interface TickReport {
  finalized: bigint[];
  applied: bigint[];
  lapsed: bigint[];
  skipped: Array<{ jobId: bigint; reason: string }>;
  expiriesRecorded: bigint[];
  nearExpiry: bigint[];
  pending: number;
  oldestPendingAgeSeconds: number;
}

function usdc(amount: bigint): number {
  return Number(amount) / 1_000_000;
}

export class Keeper {
  private readonly journaledSkips = new Set<string>();

  constructor(private readonly options: KeeperOptions) {}

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
    const report: TickReport = { finalized: [], applied: [], lapsed: [], skipped: [], expiriesRecorded: [], nearExpiry: [], pending: 0, oldestPendingAgeSeconds: 0 };
    const economics = await this.economics();
    const mirrored = [...(await jobs.listFinalizable(db, chainId, now)), ...(await jobs.listDisputedSubmitted(db, chainId))];
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

    for (const candidate of confirmed) {
      if (expiryIsNear(candidate, now)) {
        report.nearExpiry.push(candidate.jobId);
        logger.warn("keeper.expiry_near", { jobId: candidate.jobId.toString(), expiredAt: (candidate.expiredAt ?? 0n).toString() });
      }
      const action = decide(candidate, now, economics);
      if (action.kind === "lapse") {
        try {
          const result = await client.lapse(candidate.jobId);
          await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: "lapse", txHash: result.hash, gasUsed: result.receipt.gasUsed });
          metrics?.recordKeeperAction("lapse", "success");
          report.lapsed.push(candidate.jobId);
          logger.info("keeper.lapsed", { jobId: candidate.jobId.toString(), txHash: result.hash });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: "lapse", reason: message.slice(0, 200) });
          metrics?.recordKeeperAction("lapse", "failure");
          logger.error("keeper.lapse_failed", { jobId: candidate.jobId.toString(), error: message });
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
      const proof = this.options.complianceProofFor ? await this.options.complianceProofFor(candidate.jobId) : "0x";
      try {
        const result = action.kind === "finalize" ? await client.finalize(candidate.jobId, proof) : await client.finalizeDecided(candidate.jobId, proof);
        const paid = result.events.find((e) => e.contract === "KeeperEvaluator" && (e.eventName === "Finalized" || e.eventName === "DecisionApplied"));
        const fee = paid && "keeperFee" in paid.args ? (paid.args.keeperFee as bigint) : 0n;
        await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: action.kind, txHash: result.hash, gasUsed: result.receipt.gasUsed, feeEarned: fee });
        metrics?.recordKeeperAction(action.kind, "success");
        metrics?.addKeeperFeeUsdc(usdc(fee));
        (action.kind === "finalize" ? report.finalized : report.applied).push(candidate.jobId);
        logger.info("keeper.finalized", { jobId: candidate.jobId.toString(), txHash: result.hash, gasUsed: Number(result.receipt.gasUsed), fee: usdc(fee) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: action.kind, reason: message.slice(0, 200) });
        metrics?.recordKeeperAction(action.kind, "failure");
        logger.error("keeper.finalize_failed", { jobId: candidate.jobId.toString(), error: message });
      }
    }

    if (this.options.recordExpiries) await this.recordExpiries(report);
    return report;
  }

  private async recordExpiries(report: TickReport): Promise<void> {
    const { db, chainId, client, logger, metrics } = this.options;
    for (const row of await jobs.listExpiredWithAgent(db, chainId)) {
      const recorded = await client.publicClient.readContract({
        abi: squareHookAbi,
        address: client.deployment.squareHook,
        functionName: "recorded",
        args: [row.jobId],
      });
      if (recorded) continue;
      try {
        const result = await client.recordExpiry(row.jobId);
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "recordExpiry", txHash: result.hash, gasUsed: result.receipt.gasUsed });
        metrics?.recordKeeperAction("recordExpiry", "success");
        report.expiriesRecorded.push(row.jobId);
      } catch (error) {
        logger.warn("keeper.record_expiry_failed", { jobId: row.jobId.toString(), error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async run(pollIntervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.options.logger.error("keeper.tick_failed", { error: error instanceof Error ? error.message : String(error) });
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
