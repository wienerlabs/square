import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const DEFAULT_PREFIX = "square";

export type KeeperActionResult = "success" | "failure" | "skipped";

export type HookWriteKind = "reputation" | "validation";

export type AlertDispatchStage = "evaluate" | "notify";

export const PROOF_FAILURE_REASONS = [
  "timeout",
  "out_of_memory",
  "artifacts_missing",
  "circuit_mismatch",
  "witness_failed",
  "missing_field",
  "invalid_field",
  "unknown",
] as const;

export type ProofFailureReason = (typeof PROOF_FAILURE_REASONS)[number];

export const UNPARSABLE_ENDPOINT_LABEL = "unparsable";

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
  indexerLagBlocks: number | undefined;
  rpcFailovers: number;
  disputesOpen: number;
  keeperActions: number;
  keeperFailures: number;
  keeperFeeEarnedUsdc: number;
  lastKeeperTickAt: number;
  finalizeGasGap: number;
  hookWriteFailures: number;
  alertDispatchFailures: number;
  quarantinedEvents: number;
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
  keeperLastTick: string;
  finalizeGasUsed: string;
  finalizeGasGap: string;
  hookWriteFailures: string;
  alertDispatchFailures: string;
  quarantinedEvents: string;
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
  recordKeeperTick(at?: number): void;
  recordFinalizeGas(action: string, assumedGas: number | bigint, usedGas: number | bigint): void;
  recordHookWriteFailure(kind: HookWriteKind): void;
  recordAlertDispatchFailure(rule: string, stage: AlertDispatchStage): void;
  recordQuarantinedEvent(contract: string, event: string): void;
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
    keeperLastTick: `${prefix}_keeper_last_tick_timestamp_seconds`,
    finalizeGasUsed: `${prefix}_finalize_gas_used`,
    finalizeGasGap: `${prefix}_finalize_gas_gap`,
    hookWriteFailures: `${prefix}_hook_write_failures_total`,
    alertDispatchFailures: `${prefix}_alert_dispatch_failures_total`,
    quarantinedEvents: `${prefix}_indexer_quarantined_events_total`,
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

export function classifyProofFailure(reason: string): ProofFailureReason {
  const text = String(reason).toLowerCase();
  if (/timed out|timeout|etimedout|aborted/.test(text)) return "timeout";
  if (/out of memory|heap limit|enomem/.test(text)) return "out_of_memory";
  if (/enoent|no such file|artifact|\.zkey|\.wasm/.test(text)) return "artifacts_missing";
  if (/public signals|out of sync|verification key|verifier/.test(text)) return "circuit_mismatch";
  if (/witness|constraint|assert/.test(text)) return "witness_failed";
  if (/missing|required/.test(text)) return "missing_field";
  if (/must be|must not|not a valid|does not fit|exceeds|is supported|unknown weekday|invalid/.test(text)) {
    return "invalid_field";
  }
  return "unknown";
}

export function endpointLabel(value: string): string {
  try {
    const host = new URL(String(value)).host;
    return host.length === 0 ? UNPARSABLE_ENDPOINT_LABEL : label(host);
  } catch {
    return UNPARSABLE_ENDPOINT_LABEL;
  }
}

function toCount(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
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
  const keeperLastTick = new Gauge({
    name: names.keeperLastTick,
    help: "Unix time of the last keeper tick that completed without throwing. Stops advancing when the keeper stops.",
    registers,
  });
  const finalizeGasUsed = new Gauge({
    name: names.finalizeGasUsed,
    help: "Gas the last settlement transaction actually consumed, by action.",
    labelNames: ["action"] as const,
    registers,
  });
  const finalizeGasGap = new Gauge({
    name: names.finalizeGasGap,
    help: "Configured gas assumption minus the gas the last settlement transaction consumed, by action. Negative means the assumption is too low.",
    labelNames: ["action"] as const,
    registers,
  });
  const hookWriteFailures = new Counter({
    name: names.hookWriteFailures,
    help: "ERC-8004 registry writes the hook could not land, by kind. These should never fire.",
    labelNames: ["kind"] as const,
    registers,
  });
  const alertDispatchFailures = new Counter({
    name: names.alertDispatchFailures,
    help: "Alert evaluations or deliveries that failed, by rule and stage.",
    labelNames: ["rule", "stage"] as const,
    registers,
  });
  const quarantinedEvents = new Counter({
    name: names.quarantinedEvents,
    help: "Chain events the indexer could not journal or reduce and set aside, by contract and event.",
    labelNames: ["contract", "event"] as const,
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
    indexerLagBlocks: undefined,
    rpcFailovers: 0,
    disputesOpen: 0,
    keeperActions: 0,
    keeperFailures: 0,
    keeperFeeEarnedUsdc: 0,
    lastKeeperTickAt: Date.now(),
    finalizeGasGap: 0,
    hookWriteFailures: 0,
    alertDispatchFailures: 0,
    quarantinedEvents: 0,
  };
  let indexerHeadKnown = false;
  let chainHeadKnown = false;

  function updateLag(): void {
    if (!indexerHeadKnown || !chainHeadKnown) return;
    const lag = state.chainHeadBlock - state.indexerHeadBlock;
    state.indexerLagBlocks = lag;
    indexerLag.set(lag);
  }

  function observeProofDuration(seconds: number): void {
    if (!finite(seconds) || seconds < 0) return;
    state.proofAttempts += 1;
    proofDuration.observe(seconds);
  }

  function recordProofFailure(reason: string): void {
    state.proofFailures += 1;
    proofFailures.inc({ reason: classifyProofFailure(reason) });
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
      rpcFailover.inc({ from: endpointLabel(from), to: endpointLabel(to) });
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
    recordKeeperTick(at = Date.now()) {
      if (!finite(at)) return;
      state.lastKeeperTickAt = at;
      keeperLastTick.set(at / 1000);
    },
    recordFinalizeGas(action, assumedGas, usedGas) {
      const assumed = toCount(assumedGas);
      const used = toCount(usedGas);
      if (!finite(assumed) || !finite(used) || used <= 0) return;
      state.finalizeGasGap = assumed - used;
      finalizeGasUsed.set({ action: label(action) }, used);
      finalizeGasGap.set({ action: label(action) }, assumed - used);
    },
    recordHookWriteFailure(kind) {
      state.hookWriteFailures += 1;
      hookWriteFailures.inc({ kind });
    },
    recordAlertDispatchFailure(rule, stage) {
      state.alertDispatchFailures += 1;
      alertDispatchFailures.inc({ rule: label(rule), stage });
    },
    recordQuarantinedEvent(contract, event) {
      state.quarantinedEvents += 1;
      quarantinedEvents.inc({ contract: label(contract), event: label(event) });
    },
    snapshot() {
      return { ...state };
    },
  };
}
