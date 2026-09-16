import { hexToString, type Address } from "viem";
import { JobStatus, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { disputes, jobs, keeperActions, keeperJobState, type Database } from "@squaresdk/data";
import { waitUnlessAborted, type Logger, type Metrics } from "@squaresdk/observability";
import {
  decide,
  expiryIsNear,
  EXPIRY_WARNING_SECONDS,
  FULL_BPS,
  gasCostInUsdc,
  keeperFee,
  oldestPendingAge,
  profitable,
  type KeeperCandidate,
  type KeeperEconomics,
} from "./decide.js";
import { gasAssumption, type GasAssumption, type GasSource, type SettlementAction } from "./gas.js";
import type { PayeeScreening, PayeeScreenings } from "./screening.js";

export interface KeeperRetryPolicy {
  baseDelaySeconds: bigint;
  maxDelaySeconds: bigint;
  giveUpAfter: number;
  maxJournalRowsPerJob: number;
}

export const DEFAULT_EXPIRY_BATCH_SIZE = 25;
export const DEFAULT_EXPIRY_INTERVAL_MS = 60_000;
export const DEFAULT_PROOF_GRACE_SECONDS = 3_600n;

export const HOLD_REASONS = Object.freeze(["noProof", "proofStale"] as const);

export type HoldReason = (typeof HOLD_REASONS)[number];

export interface HoldRule {
  reason: HoldReason;
  graceSeconds: bigint | null;
  examine(candidate: KeeperCandidate): Promise<string | null>;
}

interface Refusal {
  reason: HoldReason;
  detail: string;
  graceSeconds: bigint | null;
}

export const KEEPER_LOG_FIELDS: readonly string[] = Object.freeze(["attempts", "retryInSeconds"]);

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
  pinnedFinalizeGas?: boolean;
  finalizeGasSamples?: number;
  complianceModule?: Address | null;
  gated?: boolean;
  proofGraceSeconds?: bigint;
  recordExpiries: boolean;
  expiryBatchSize?: number;
  expiryIntervalMs?: number;
  ephemeralMirror?: boolean;
  retryPolicy?: KeeperRetryPolicy;
  /**
   * square#35. Asked once a tick, with every job about to be finalized: whether
   * each payee is cleared by its job's screening registry, after the screener
   * was asked for fresh screenings of all of them. A job it says not to proceed
   * with is held, not refused. A job whose screening could not be read is a
   * failed attempt, backed off like a failed send (payeeScreening).
   */
  screenPayees?: PayeeScreenings;
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
  bondsSettled: bigint[];
  skipped: Array<{ jobId: bigint; reason: string }>;
  held: Array<{ jobId: bigint; reason: HoldReason }>;
  nearExpiry: bigint[];
  pending: number;
  unprofitable: number;
  oldestPendingAgeSeconds: number;
}

export interface ExpirySweepReport {
  scanned: number;
  recorded: bigint[];
  alreadyRecorded: bigint[];
  failed: bigint[];
  gaveUp: bigint[];
}

function usdc(amount: bigint): number {
  return Number(amount) / 1_000_000;
}

type NotYetOnChain = "windowOpen" | "notLapsed";

function notYetOnChain(message: string): NotYetOnChain | null {
  if (message.includes("WindowOpen")) return "windowOpen";
  if (message.includes("NotLapsed")) return "notLapsed";
  return null;
}

export function refusedForWantOfAProof(message: string): boolean {
  return message.includes("ProofRequired");
}

export class Keeper {
  private readonly journaledSkips = new Set<string>();
  private readonly warnedNearExpiry = new Set<string>();
  private readonly retries = new Map<string, RetryState>();
  private readonly gas: GasAssumption;
  private readonly rules: HoldRule[];

  constructor(private readonly options: KeeperOptions) {
    this.gas = gasAssumption({
      finalizeGas: options.defaultFinalizeGas,
      finalizeDecidedGas: options.defaultFinalizeDecidedGas,
      ...(options.pinnedFinalizeGas === undefined ? {} : { pinned: options.pinnedFinalizeGas }),
      ...(options.finalizeGasSamples === undefined ? {} : { samples: options.finalizeGasSamples }),
    });
    this.rules = (options.gated ?? options.complianceModule != null) ? [this.noProofRule(), this.proofRule()] : [];
  }

  gasAssumed(action: SettlementAction): bigint {
    return this.gas.assumed(action);
  }

  gasSource(action: SettlementAction): GasSource {
    return this.gas.source(action);
  }

  private get proofGraceSeconds(): bigint {
    return this.options.proofGraceSeconds ?? DEFAULT_PROOF_GRACE_SECONDS;
  }

  private noProofRule(): HoldRule {
    const { client } = this.options;
    return {
      reason: "noProof",
      graceSeconds: null,
      examine: async (candidate) => {
        const state = await client.proofState(candidate.jobId);
        if (state === "notGated" || state === "decidable") return null;
        return state === "missing"
          ? "the client has bound no compliance proof, and the evaluator will not settle a job with nothing to decide"
          : `the proof bound to this job is ${state}, and the evaluator will not settle a job with nothing to decide`;
      },
    };
  }

  private proofRule(): HoldRule {
    const { client } = this.options;
    return {
      reason: "proofStale",
      graceSeconds: this.proofGraceSeconds,
      examine: async (candidate) => {
        const owner = candidate.client;
        if (owner === undefined || owner === null) return null;
        const [payee, net, proof] = await Promise.all([
          client.payeeOf(candidate.jobId),
          client.netPayout(candidate.jobId),
          client.complianceProofOf(candidate.jobId),
        ]);
        const share = candidate.providerBps ?? null;
        const amount = share === null ? net : (net * BigInt(share)) / FULL_BPS;
        const verdict = await client.previewRelease({ jobId: candidate.jobId, payee, amount, client: owner, proof });
        if (verdict !== false) return null;
        return proof === "0x"
          ? "the client has bound no compliance proof, so this release would pay the client back and the payee nothing"
          : "the module refuses the proof bound to this job, so this release would pay the client back and the payee nothing";
      },
    };
  }

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

  private async noteFailure(jobId: bigint, action: "finalize" | "finalizeDecided" | "lapse" | "settleBond", message: string, now: bigint): Promise<boolean> {
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
      await keeperActions.append(db, { chainId, jobId, action, reason, gaveUp: state.gaveUp });
    }
    if (state.gaveUp) await keeperJobState.markFinalizeGaveUp(db, chainId, jobId);
    metrics?.recordKeeperAction(action, "failure");
    if (state.gaveUp) {
      logger.error("keeper.gave_up", { jobId: key, attempts: state.attempts, error: message });
    } else {
      logger.error("keeper.finalize_failed", { jobId: key, attempts: state.attempts, retryInSeconds: Number(delay), error: message });
    }
    return state.gaveUp;
  }

  async restoreGiveUps(): Promise<bigint[]> {
    const { db, chainId, logger } = this.options;
    const restored = await keeperJobState.listFinalizeGaveUp(db, chainId);
    for (const jobId of restored) {
      const key = jobId.toString();
      if (this.retries.has(key)) continue;
      this.retries.set(key, {
        attempts: this.retryPolicy.giveUpAfter,
        nextAttemptAt: 0n,
        gaveUp: true,
        journaled: new Set<string>(),
      });
    }
    if (restored.length > 0) {
      logger.info("keeper.give_ups_restored", {
        count: restored.length,
        reason: "these jobs were given up on before this process started and stay skipped until an operator clears keeper_job_state.finalize_gave_up",
      });
    }
    return restored;
  }

  private async latestBlockTimestamp(): Promise<bigint> {
    const block = await this.options.client.publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp;
  }

  private async economics(): Promise<KeeperEconomics> {
    const gasPriceWei = await this.options.client.publicClient.getGasPrice();
    return {
      gasPriceWei,
      finalizeGas: this.gas.assumed("finalize"),
      finalizeDecidedGas: this.gas.assumed("finalizeDecided"),
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
    let providerBps: number | null = 10_000;
    if (disputed) {
      const dispute = await client.disputeOf(jobId);
      decidedOutcome = dispute.outcome;
      resolveBy = BigInt(dispute.resolveBy);
      providerBps = dispute.outcome === 0 ? null : Number(dispute.providerBps);
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
      client: record.client,
      providerBps,
    };
  }

  async tick(atTimestamp?: bigint): Promise<TickReport> {
    const { db, chainId, client, logger, metrics } = this.options;
    const now = atTimestamp ?? (await this.latestBlockTimestamp());
    const report: TickReport = {
      finalized: [],
      applied: [],
      lapsed: [],
      bondsSettled: [],
      skipped: [],
      held: [],
      nearExpiry: [],
      pending: 0,
      unprofitable: 0,
      oldestPendingAgeSeconds: 0,
    };
    const economics = await this.economics();
    const evaluator = client.deployment.keeperEvaluator;
    const finalizable = await jobs.listFinalizable(db, chainId, now, evaluator);
    const underDispute = await jobs.listDisputedSubmitted(db, chainId, evaluator);
    if (this.options.ephemeralMirror === true && finalizable.length === 0 && underDispute.length === 0) {
      logger.warn("keeper.empty_mirror", {
        reason: "DATABASE_URL is not set, so this keeper reads a private in-memory mirror that no indexer writes to and it will never find a candidate",
      });
    }
    const worthAsking: jobs.JobRecord[] = [...underDispute];
    for (const row of finalizable) {
      if (this.profitableInMirror(row, economics)) {
        worthAsking.push(row);
        continue;
      }
      report.skipped.push({ jobId: row.jobId, reason: "unprofitable" });
      report.unprofitable += 1;
      if (expiryIsNear({ expiredAt: row.expiredAt }, now)) {
        report.nearExpiry.push(row.jobId);
        this.warnOnceOnNearExpiry({ jobId: row.jobId, expiredAt: row.expiredAt }, now);
      }
      await this.journalUnprofitableOnce(row.jobId, row.budget, row.evaluatorFeeBp ?? 0, economics.finalizeGas, economics);
    }
    const confirmed: KeeperCandidate[] = [];
    for (const row of worthAsking) {
      const candidate = await this.candidateFromChain(row.jobId);
      if (candidate) confirmed.push(candidate);
    }
    report.pending = confirmed.filter((c) => !c.disputed && c.challengeEnd !== null && now >= c.challengeEnd).length;
    report.oldestPendingAgeSeconds = Number(oldestPendingAge(confirmed, now));
    metrics?.setFinalizePending(report.pending);
    metrics?.setOldestPendingAgeSeconds(report.oldestPendingAgeSeconds);
    metrics?.setDisputesOpen(await disputes.countOpen(db, chainId));
    await this.forgetJobsThatLeft([...finalizable, ...underDispute].map((row) => row.jobId));

    const sending: Array<{ candidate: KeeperCandidate; kind: "finalize" | "finalizeDecided" }> = [];
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
          const message = error instanceof Error ? error.message : String(error);
          const behind = notYetOnChain(message);
          if (behind === null) await this.noteFailure(candidate.jobId, "lapse", message, now);
          else this.skipUntilTheChainCatchesUp(candidate.jobId, behind, report);
        }
        continue;
      }
      if (action.kind === "skip") {
        report.skipped.push({ jobId: candidate.jobId, reason: action.reason });
        if (action.reason === "unprofitable") {
          report.unprofitable += 1;
          await this.journalUnprofitableOnce(
            candidate.jobId,
            candidate.budget,
            candidate.evaluatorFeeBP ?? 0,
            candidate.disputed ? economics.finalizeDecidedGas : economics.finalizeGas,
            economics,
          );
        }
        continue;
      }
      sending.push({ candidate, kind: action.kind });
    }

    // square#35: the payees of every job about to be sent are screened together,
    // before any of them is sent. One job's screening failing is that job's
    // failed attempt; the others still go.
    let screenings: Map<bigint, PayeeScreening | Error> | undefined;
    if (this.options.screenPayees && sending.length > 0) {
      try {
        screenings = await this.options.screenPayees(sending.map(({ candidate }) => candidate.jobId));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        screenings = new Map(sending.map(({ candidate }) => [candidate.jobId, failure]));
      }
    }

    for (const { candidate, kind } of sending) {
      if (screenings !== undefined) {
        const screening = screenings.get(candidate.jobId) ?? new Error("the screening returned nothing for this job");
        if (screening instanceof Error) {
          await this.noteFailure(candidate.jobId, kind, `screening the payee failed: ${screening.message}`, now);
          continue;
        }
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
      if (!(await this.clearedByHolds(candidate, now, report))) continue;
      try {
        const result = kind === "finalize" ? await client.finalize(candidate.jobId) : await client.finalizeDecided(candidate.jobId);
        const paid = result.events.find((e) => e.contract === "KeeperEvaluator" && (e.eventName === "Finalized" || e.eventName === "DecisionApplied"));
        const fee = paid && "keeperFee" in paid.args ? (paid.args.keeperFee as bigint) : 0n;
        await keeperActions.append(db, { chainId, jobId: candidate.jobId, action: kind, txHash: result.hash, gasUsed: result.receipt.gasUsed, feeEarned: fee });
        metrics?.recordKeeperAction(kind, "success");
        metrics?.addKeeperFeeUsdc(usdc(fee));
        metrics?.recordFinalizeGas(
          kind,
          kind === "finalize" ? economics.finalizeGas : economics.finalizeDecidedGas,
          result.receipt.gasUsed,
        );
        this.gas.record(kind, result.receipt.gasUsed);
        this.reportRefusal(candidate.jobId, result.events);
        await keeperJobState.releaseHold(db, chainId, candidate.jobId);
        this.retries.delete(candidate.jobId.toString());
        (kind === "finalize" ? report.finalized : report.applied).push(candidate.jobId);
        logger.info("keeper.finalized", { jobId: candidate.jobId.toString(), txHash: result.hash, gasUsed: Number(result.receipt.gasUsed), fee: usdc(fee) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const behind = notYetOnChain(message);
        if (refusedForWantOfAProof(message)) await this.holdForWantOfAProof(candidate, now, report, message);
        else if (behind === null) await this.noteFailure(candidate.jobId, kind, message, now);
        else this.skipUntilTheChainCatchesUp(candidate.jobId, behind, report);
      }
    }

    await this.settleBondsOfExpiredJobs(now, report);
    await this.reportHolds();

    metrics?.recordKeeperTick();
    return report;
  }

  private async holdForWantOfAProof(
    candidate: KeeperCandidate,
    now: bigint,
    report: TickReport,
    message: string,
  ): Promise<void> {
    const { db, chainId, logger } = this.options;
    await keeperJobState.hold(db, chainId, candidate.jobId, "noProof", now);
    this.retries.delete(candidate.jobId.toString());
    report.held.push({ jobId: candidate.jobId, reason: "noProof" });
    report.skipped.push({ jobId: candidate.jobId, reason: "noProof" });
    logger.info("keeper.held", {
      jobId: candidate.jobId.toString(),
      reason: `noProof: the evaluator refused to settle a job with nothing to decide (${message}); this is not a failed attempt and costs no retry, and only the client can end it`,
    });
  }

  private async clearedByHolds(candidate: KeeperCandidate, now: bigint, report: TickReport): Promise<boolean> {
    const { db, chainId, logger } = this.options;
    if (this.rules.length === 0) return true;
    const key = candidate.jobId.toString();
    let refusal: Refusal | null = null;
    for (const rule of this.rules) {
      let detail: string | null;
      try {
        detail = await rule.examine(candidate);
      } catch (error) {
        logger.error("keeper.hold_rule_failed", {
          jobId: key,
          reason: `${rule.reason} could not be examined, so nothing is held for it this tick: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (detail === null) continue;
      refusal = { reason: rule.reason, detail, graceSeconds: rule.graceSeconds };
      break;
    }
    if (refusal === null) {
      await keeperJobState.releaseHold(db, chainId, candidate.jobId);
      return true;
    }
    const since = await keeperJobState.hold(db, chainId, candidate.jobId, refusal.reason, now);
    const waited = now - since;
    if (refusal.graceSeconds !== null && waited >= refusal.graceSeconds) {
      logger.warn("keeper.hold_expired", {
        jobId: key,
        reason: `held as ${refusal.reason} for ${waited}s, past the ${refusal.graceSeconds}s grace, so it is cranked anyway: ${refusal.detail}`,
      });
      return true;
    }
    report.held.push({ jobId: candidate.jobId, reason: refusal.reason });
    report.skipped.push({ jobId: candidate.jobId, reason: refusal.reason });
    logger.info("keeper.held", {
      jobId: key,
      reason:
        refusal.graceSeconds === null
          ? `${refusal.reason}: ${refusal.detail}; this is not a failed attempt, the next tick looks again, and only the client can end it`
          : `${refusal.reason}: ${refusal.detail}; this is not a failed attempt, the next tick looks again, and after ${refusal.graceSeconds}s it is cranked regardless`,
    });
    return false;
  }

  private reportRefusal(jobId: bigint, events: Awaited<ReturnType<SquareClient["finalize"]>>["events"]): void {
    const { logger, metrics } = this.options;
    const refused = events.find((event) => event.contract === "ComplianceModule" && event.eventName === "ReleaseRefused");
    if (refused === undefined) return;
    const checked = events.find((event) => event.contract === "SquareHook" && event.eventName === "ComplianceChecked");
    const amount = checked !== undefined && "amount" in checked.args ? (checked.args.amount as bigint) : 0n;
    const reason = "reason" in refused.args ? hexToString(refused.args.reason as `0x${string}`, { size: 32 }).replace(/\0+$/, "") : "unknown";
    metrics?.recordReleaseRefused(reason, amount);
    logger.warn("keeper.release_refused", {
      jobId: jobId.toString(),
      fee: usdc(amount),
      reason: `the module refused this release (${reason}); the payee got nothing and the client was paid back`,
    });
  }

  private async reportHolds(): Promise<void> {
    const { db, chainId, metrics } = this.options;
    if (metrics === undefined) return;
    const counts = await keeperJobState.countHeld(db, chainId);
    for (const reason of HOLD_REASONS) metrics.setHeldJobs(reason, counts[reason] ?? 0);
  }

  private skipUntilTheChainCatchesUp(jobId: bigint, reason: NotYetOnChain, report: TickReport): void {
    report.skipped.push({ jobId, reason });
    this.options.logger.info("keeper.not_yet", {
      jobId: jobId.toString(),
      reason: `the chain has not reached this job's deadline yet (${reason}), so this is not a failed attempt and costs neither a journal row nor a backoff`,
    });
  }

  private async settleBondsOfExpiredJobs(now: bigint, report: TickReport): Promise<void> {
    const { db, chainId, client, logger, metrics } = this.options;
    const rows = await jobs.listExpiredDisputed(db, chainId, client.deployment.keeperEvaluator);
    for (const row of rows) {
      const retry = this.retryOf(row.jobId);
      if (retry?.gaveUp === true) {
        report.skipped.push({ jobId: row.jobId, reason: "gaveUp" });
        continue;
      }
      if (retry !== undefined && now < retry.nextAttemptAt) {
        report.skipped.push({ jobId: row.jobId, reason: "backoff" });
        continue;
      }
      const dispute = await client.disputeOf(row.jobId);
      if (dispute.disputedAt === 0 || dispute.bondSettled) continue;
      try {
        const result = await client.settleBond(row.jobId);
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "settleBond", txHash: result.hash, gasUsed: result.receipt.gasUsed });
        metrics?.recordKeeperAction("settleBond", "success");
        this.retries.delete(row.jobId.toString());
        report.bondsSettled.push(row.jobId);
        logger.info("keeper.bond_settled", {
          jobId: row.jobId.toString(),
          txHash: result.hash,
          reason: "the job expired under its dispute, so the bond is routed the way the decision says and nobody had to know the ABI",
        });
      } catch (error) {
        await this.noteFailure(row.jobId, "settleBond", error instanceof Error ? error.message : String(error), now);
      }
    }
  }

  private profitableInMirror(row: jobs.JobRecord, economics: KeeperEconomics): boolean {
    const fee = keeperFee(row.budget, row.evaluatorFeeBp ?? 0);
    const gasCost = gasCostInUsdc(economics.gasPriceWei, economics.finalizeGas);
    return profitable(fee, gasCost, economics.minimumMarginBps);
  }

  private async journalUnprofitableOnce(jobId: bigint, budget: bigint, evaluatorFeeBP: number, gas: bigint, economics: KeeperEconomics): Promise<void> {
    const { db, chainId, logger, metrics } = this.options;
    const key = jobId.toString();
    if (this.journaledSkips.has(key)) return;
    const firstEver = await keeperJobState.markUnprofitableJournaled(db, chainId, jobId);
    this.journaledSkips.add(key);
    if (firstEver) await keeperActions.append(db, { chainId, jobId, action: "skipped", reason: "unprofitable" });
    metrics?.recordKeeperAction("finalize", "skipped");
    logger.info("keeper.skipped", {
      jobId: key,
      reason: "unprofitable",
      fee: usdc(keeperFee(budget, evaluatorFeeBP)),
      gasUsed: Number(gasCostInUsdc(economics.gasPriceWei, gas)),
    });
  }

  private async forgetJobsThatLeft(mirrored: bigint[]): Promise<void> {
    const { db, chainId } = this.options;
    const present = new Set(mirrored.map((jobId) => jobId.toString()));
    for (const key of this.warnedNearExpiry) {
      if (!present.has(key)) this.warnedNearExpiry.delete(key);
    }
    for (const held of await keeperJobState.listHeld(db, chainId)) {
      if (!present.has(held.jobId.toString())) await keeperJobState.releaseHold(db, chainId, held.jobId);
    }
  }

  private warnOnceOnNearExpiry(candidate: Pick<KeeperCandidate, "jobId" | "expiredAt">, now: bigint): void {
    const key = candidate.jobId.toString();
    if (this.warnedNearExpiry.has(key)) return;
    this.warnedNearExpiry.add(key);
    const left = (candidate.expiredAt ?? 0n) - now;
    this.options.logger.warn("keeper.expiry_near", {
      jobId: key,
      reason: `expires in ${left}s, inside the ${EXPIRY_WARNING_SECONDS}s warning window`,
    });
  }

  async sweepExpiries(atTimestamp?: bigint): Promise<ExpirySweepReport> {
    const { db, chainId, client, logger, metrics } = this.options;
    const now = atTimestamp ?? (await this.latestBlockTimestamp());
    const report: ExpirySweepReport = { scanned: 0, recorded: [], alreadyRecorded: [], failed: [], gaveUp: [] };
    const rows = await jobs.listExpiredWithAgent(db, chainId, client.deployment.keeperEvaluator, this.expiryBatchSize, now);
    report.scanned = rows.length;
    for (const row of rows) {
      const recorded = await client.publicClient.readContract({
        abi: squareHookAbi,
        address: client.deployment.squareHook,
        functionName: "recorded",
        args: [row.jobId],
      });
      if (recorded) {
        await keeperJobState.markExpiryRecorded(db, chainId, row.jobId);
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "recordExpiry" });
        report.alreadyRecorded.push(row.jobId);
        logger.info("keeper.expiry_already_recorded", {
          jobId: row.jobId.toString(),
          reason: "the hook already carries this expiry, marked so the sweep stops asking the chain about it",
        });
        continue;
      }
      try {
        const result = await client.recordExpiry(row.jobId);
        await keeperJobState.markExpiryRecorded(db, chainId, row.jobId);
        await keeperActions.append(db, { chainId, jobId: row.jobId, action: "recordExpiry", txHash: result.hash, gasUsed: result.receipt.gasUsed });
        metrics?.recordKeeperAction("recordExpiry", "success");
        report.recorded.push(row.jobId);
      } catch (error) {
        await this.noteExpiryFailure(row.jobId, error instanceof Error ? error.message : String(error), now, report);
      }
    }
    return report;
  }

  private async noteExpiryFailure(jobId: bigint, message: string, now: bigint, report: ExpirySweepReport): Promise<void> {
    const { db, chainId, logger, metrics } = this.options;
    const policy = this.retryPolicy;
    const key = jobId.toString();
    const attempts = await keeperJobState.bumpExpiryAttempts(db, chainId, jobId);
    const gaveUp = attempts >= policy.giveUpAfter;
    const delay = this.backoffSeconds(attempts);
    await keeperJobState.scheduleExpiryRetry(db, chainId, jobId, now + delay, gaveUp);
    if (gaveUp || attempts <= policy.maxJournalRowsPerJob) {
      const reason = gaveUp ? `gave up after ${attempts} attempts: ${message}`.slice(0, 200) : message.slice(0, 200);
      await keeperActions.append(db, { chainId, jobId, action: "recordExpiry", reason, gaveUp });
    }
    metrics?.recordKeeperAction("recordExpiry", "failure");
    if (gaveUp) {
      report.gaveUp.push(jobId);
      logger.error("keeper.record_expiry_gave_up", { jobId: key, attempts, error: message });
      return;
    }
    report.failed.push(jobId);
    logger.warn("keeper.record_expiry_failed", { jobId: key, attempts, retryInSeconds: Number(delay), error: message });
  }

  async run(pollIntervalMs: number, signal: AbortSignal): Promise<void> {
    await this.restoreGiveUps();
    let nextExpirySweepAt = 0;
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.options.logger.error("keeper.tick_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (signal.aborted) break;
      if (this.options.recordExpiries && performance.now() >= nextExpirySweepAt) {
        try {
          await this.sweepExpiries();
        } catch (error) {
          this.options.logger.error("keeper.expiry_sweep_failed", { error: error instanceof Error ? error.message : String(error) });
        }
        nextExpirySweepAt = performance.now() + this.expiryIntervalMs;
      }
      await waitUnlessAborted(pollIntervalMs, signal);
    }
  }
}
