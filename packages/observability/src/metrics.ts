import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const DEFAULT_PREFIX = "square";

export type KeeperActionResult = "success" | "failure" | "skipped";

export interface MetricsOptions {
  service: string;
  prefix?: string;
  defaultMetrics?: boolean;
  proofDurationBuckets?: readonly number[];
  disputeResolutionBuckets?: readonly number[];
}

export interface ProofTimer {
  success(): number;
  failure(reason: string): number;
}

export interface MetricsSnapshot {
  finalizePending: number;
  oldestPendingAgeSeconds: number;
  proofAttempts: number;
  proofFailures: number;
  verificationRejections: number;
  indexerHeadBlock: number;
  chainHeadBlock: number;
  indexerLagBlocks: number;
  rpcFailovers: number;
  disputesOpen: number;
  keeperActions: number;
  keeperFailures: number;
  keeperFeeEarnedUsdc: number;
}

export interface MetricNames {
  finalizePending: string;
  finalizeOldestPendingAge: string;
  proofDuration: string;
  proofFailures: string;
  verificationRejections: string;
  indexerLag: string;
  indexerHead: string;
  chainHead: string;
  rpcFailover: string;
  disputesOpen: string;
  disputeResolution: string;
  keeperActions: string;
  keeperFeeEarned: string;
}

export interface Metrics {
  readonly registry: Registry;
  readonly service: string;
  readonly prefix: string;
  readonly names: MetricNames;
  setFinalizePending(count: number): void;
  setOldestPendingAgeSeconds(seconds: number): void;
  observeProofDuration(seconds: number): void;
  startProof(): ProofTimer;
  recordProofFailure(reason: string): void;
  recordVerificationRejection(rule: string): void;
  setIndexerHead(block: number | bigint): void;
  setChainHead(block: number | bigint): void;
  recordRpcFailover(from: string, to: string): void;
  setDisputesOpen(count: number): void;
  observeDisputeResolution(seconds: number): void;
  recordKeeperAction(action: string, result: KeeperActionResult): void;
  addKeeperFeeUsdc(amount: number): void;
  snapshot(): MetricsSnapshot;
}

const HOUR = 3600;
const DAY = 24 * HOUR;
const DEFAULT_PROOF_BUCKETS: readonly number[] = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];
const DEFAULT_DISPUTE_BUCKETS: readonly number[] = [HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY];
const MAX_LABEL_LENGTH = 128;

export function metricNames(prefix: string = DEFAULT_PREFIX): MetricNames {
  return {
    finalizePending: `${prefix}_finalize_pending_total`,
    finalizeOldestPendingAge: `${prefix}_finalize_oldest_pending_age_seconds`,
    proofDuration: `${prefix}_proof_duration_seconds`,
    proofFailures: `${prefix}_proof_failures_total`,
    verificationRejections: `${prefix}_onchain_verification_rejections_total`,
    indexerLag: `${prefix}_indexer_lag_blocks`,
    indexerHead: `${prefix}_indexer_head_block`,
    chainHead: `${prefix}_chain_head_block`,
    rpcFailover: `${prefix}_rpc_failover_total`,
    disputesOpen: `${prefix}_disputes_open_total`,
    disputeResolution: `${prefix}_dispute_resolution_seconds`,
    keeperActions: `${prefix}_keeper_actions_total`,
    keeperFeeEarned: `${prefix}_keeper_fee_earned_usdc`,
  };
}

export function renderMetrics(registry: Registry): Promise<string> {
  return registry.metrics();
}

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function label(value: string): string {
  return String(value).slice(0, MAX_LABEL_LENGTH);
}

function toBlock(block: number | bigint): number {
  return typeof block === "bigint" ? Number(block) : block;
}

function nowSeconds(): number {
  return performance.now() / 1000;
}

export function createMetrics(options: MetricsOptions): Metrics {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const names = metricNames(prefix);
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
  const registers = [registry];

  const finalizePending = new Gauge({
    name: names.finalizePending,
    help: "Jobs whose challenge window has closed and that are not finalized yet.",
    registers,
  });
  const oldestPendingAge = new Gauge({
    name: names.finalizeOldestPendingAge,
    help: "Seconds since the challenge window closed for the oldest unfinalized job. Rising means the keeper stopped.",
    registers,
  });
  const proofDuration = new Histogram({
    name: names.proofDuration,
    help: "Wall-clock seconds spent generating one Groth16 proof, successful or not.",
    buckets: [...(options.proofDurationBuckets ?? DEFAULT_PROOF_BUCKETS)],
    registers,
  });
  const proofFailures = new Counter({
    name: names.proofFailures,
    help: "Proof generation attempts that failed, by reason.",
    labelNames: ["reason"] as const,
    registers,
  });
  const verificationRejections = new Counter({
    name: names.verificationRejections,
    help: "Proofs the on-chain verifier rejected, by rule.",
    labelNames: ["rule"] as const,
    registers,
  });
  const indexerLag = new Gauge({
    name: names.indexerLag,
    help: "Chain head block minus the last block the indexer applied.",
    registers,
  });
  const indexerHead = new Gauge({
    name: names.indexerHead,
    help: "Last block the indexer applied.",
    registers,
  });
  const chainHead = new Gauge({
    name: names.chainHead,
    help: "Latest block reported by the RPC endpoint in use.",
    registers,
  });
  const rpcFailover = new Counter({
    name: names.rpcFailover,
    help: "RPC endpoint switches, by source and destination.",
    labelNames: ["from", "to"] as const,
    registers,
  });
  const disputesOpen = new Gauge({
    name: names.disputesOpen,
    help: "Disputes raised and not yet decided or expired.",
    registers,
  });
  const disputeResolution = new Histogram({
    name: names.disputeResolution,
    help: "Seconds from dispute opened to decision or expiry.",
    buckets: [...(options.disputeResolutionBuckets ?? DEFAULT_DISPUTE_BUCKETS)],
    registers,
  });
  const keeperActions = new Counter({
    name: names.keeperActions,
    help: "Keeper transactions attempted, by action and result.",
    labelNames: ["action", "result"] as const,
    registers,
  });
  const keeperFeeEarned = new Counter({
    name: names.keeperFeeEarned,
    help: "Evaluator fees the keeper collected, in USDC.",
    registers,
  });

  const state: MetricsSnapshot = {
    finalizePending: 0,
    oldestPendingAgeSeconds: 0,
    proofAttempts: 0,
    proofFailures: 0,
    verificationRejections: 0,
    indexerHeadBlock: 0,
    chainHeadBlock: 0,
    indexerLagBlocks: 0,
    rpcFailovers: 0,
    disputesOpen: 0,
    keeperActions: 0,
    keeperFailures: 0,
    keeperFeeEarnedUsdc: 0,
  };
  let indexerHeadKnown = false;
  let chainHeadKnown = false;

  function updateLag(): void {
    if (!indexerHeadKnown || !chainHeadKnown) return;
    state.indexerLagBlocks = state.chainHeadBlock - state.indexerHeadBlock;
    indexerLag.set(state.indexerLagBlocks);
  }

  function observeProofDuration(seconds: number): void {
    if (!finite(seconds) || seconds < 0) return;
    state.proofAttempts += 1;
    proofDuration.observe(seconds);
  }

  function recordProofFailure(reason: string): void {
    state.proofFailures += 1;
    proofFailures.inc({ reason: label(reason) });
  }

  return {
    registry,
    service: options.service,
    prefix,
    names,
    setFinalizePending(count) {
      if (!finite(count)) return;
      state.finalizePending = count;
      finalizePending.set(count);
    },
    setOldestPendingAgeSeconds(seconds) {
      if (!finite(seconds)) return;
      state.oldestPendingAgeSeconds = seconds;
      oldestPendingAge.set(seconds);
    },
    observeProofDuration,
    startProof() {
      const started = nowSeconds();
      let settled = false;
      const elapsed = (): number => nowSeconds() - started;
      return {
        success() {
          const seconds = elapsed();
          if (settled) return seconds;
          settled = true;
          observeProofDuration(seconds);
          return seconds;
        },
        failure(reason) {
          const seconds = elapsed();
          if (settled) return seconds;
          settled = true;
          observeProofDuration(seconds);
          recordProofFailure(reason);
          return seconds;
        },
      };
    },
    recordProofFailure,
    recordVerificationRejection(rule) {
      state.verificationRejections += 1;
      verificationRejections.inc({ rule: label(rule) });
    },
    setIndexerHead(block) {
      const value = toBlock(block);
      if (!finite(value)) return;
      state.indexerHeadBlock = value;
      indexerHeadKnown = true;
      indexerHead.set(value);
      updateLag();
    },
    setChainHead(block) {
      const value = toBlock(block);
      if (!finite(value)) return;
      state.chainHeadBlock = value;
      chainHeadKnown = true;
      chainHead.set(value);
      updateLag();
    },
    recordRpcFailover(from, to) {
      state.rpcFailovers += 1;
      rpcFailover.inc({ from: label(from), to: label(to) });
    },
    setDisputesOpen(count) {
      if (!finite(count)) return;
      state.disputesOpen = count;
      disputesOpen.set(count);
    },
    observeDisputeResolution(seconds) {
      if (!finite(seconds) || seconds < 0) return;
      disputeResolution.observe(seconds);
    },
    recordKeeperAction(action, result) {
      state.keeperActions += 1;
      if (result === "failure") state.keeperFailures += 1;
      keeperActions.inc({ action: label(action), result });
    },
    addKeeperFeeUsdc(amount) {
      if (!finite(amount) || amount < 0) return;
      state.keeperFeeEarnedUsdc += amount;
      keeperFeeEarned.inc(amount);
    },
    snapshot() {
      return { ...state };
    },
  };
}
