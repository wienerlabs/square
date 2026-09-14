import { describe, it, expect } from "vitest";
import {
  createMetrics,
  renderMetrics,
  metricNames,
  endpointLabel,
  PROOF_FAILURE_REASONS,
  UNPARSABLE_ENDPOINT_LABEL,
} from "../src/metrics.js";
import { indexerLagging } from "../src/alerts.js";

interface MetricValue {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

interface MetricJson {
  name: string;
  values: MetricValue[];
}

async function valueOf(
  registry: { getMetricsAsJSON(): Promise<unknown> },
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const all = (await registry.getMetricsAsJSON()) as MetricJson[];
  const candidates = all.flatMap((m) => m.values.map((v) => ({ ...v, metricName: v.metricName ?? m.name })));
  const found = candidates.find(
    (v) => v.metricName === name && Object.entries(labels).every(([k, expected]) => String(v.labels[k]) === expected),
  );
  return found?.value;
}

describe("metric names", () => {
  it("uses the square prefix by default", () => {
    const names = metricNames();
    expect(Object.values(names)).toEqual([
      "square_finalize_pending_total",
      "square_finalize_oldest_pending_age_seconds",
      "square_proof_duration_seconds",
      "square_proof_failures_total",
      "square_onchain_verification_rejections_total",
      "square_indexer_lag_blocks",
      "square_indexer_head_block",
      "square_chain_head_block",
      "square_rpc_failover_total",
      "square_disputes_open_total",
      "square_dispute_resolution_seconds",
      "square_keeper_actions_total",
      "square_keeper_fee_earned_usdc",
      "square_keeper_last_tick_timestamp_seconds",
      "square_finalize_gas_used",
      "square_finalize_gas_gap",
      "square_hook_write_failures_total",
      "square_alert_dispatch_failures_total",
      "square_indexer_quarantined_events_total",
    ]);
  });

  it("honours a custom prefix", async () => {
    const metrics = createMetrics({ service: "keeper", prefix: "sq", defaultMetrics: false });
    metrics.setFinalizePending(1);
    const text = await renderMetrics(metrics.registry);
    expect(text).toContain("sq_finalize_pending_total");
    expect(text).not.toContain("square_");
  });
});

describe("helpers update the registry", () => {
  it("renders every signal by name with the service label", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    metrics.setFinalizePending(3);
    metrics.setOldestPendingAgeSeconds(720);
    metrics.observeProofDuration(4.2);
    metrics.recordProofFailure("witness");
    metrics.recordVerificationRejection("per_tx_ceiling");
    metrics.setChainHead(1000n);
    metrics.setIndexerHead(990);
    metrics.recordRpcFailover("primary", "fallback");
    metrics.setDisputesOpen(2);
    metrics.observeDisputeResolution(3600);
    metrics.recordKeeperAction("finalize", "success");
    metrics.addKeeperFeeUsdc(1.25);

    const text = await renderMetrics(metrics.registry);
    for (const name of Object.values(metricNames())) expect(text).toContain(name);
    expect(text).toMatch(/square_finalize_pending_total\{service="keeper"\} 3/);
    expect(text).toMatch(/square_finalize_oldest_pending_age_seconds\{service="keeper"\} 720/);
    expect(text).toMatch(/square_indexer_lag_blocks\{service="keeper"\} 10/);
    expect(text).toContain("square_proof_duration_seconds_bucket");
    expect(text).toContain("square_dispute_resolution_seconds_sum");
  });

  it("counts failures and rejections by label", async () => {
    const metrics = createMetrics({ service: "prover", defaultMetrics: false });
    metrics.recordProofFailure("witness");
    metrics.recordProofFailure("witness");
    metrics.recordProofFailure("timeout");
    metrics.recordVerificationRejection("per_tx_ceiling");
    const { registry, names } = metrics;
    expect(await valueOf(registry, names.proofFailures, { reason: "witness_failed" })).toBe(2);
    expect(await valueOf(registry, names.proofFailures, { reason: "timeout" })).toBe(1);
    expect(await valueOf(registry, names.verificationRejections, { rule: "per_tx_ceiling" })).toBe(1);
    expect(metrics.snapshot().proofFailures).toBe(3);
    expect(metrics.snapshot().verificationRejections).toBe(1);
  });

  it("derives indexer lag from the two heads", async () => {
    const metrics = createMetrics({ service: "indexer", defaultMetrics: false });
    expect(metrics.snapshot().indexerLagBlocks).toBeUndefined();
    metrics.setIndexerHead(500);
    expect(metrics.snapshot().indexerLagBlocks).toBeUndefined();
    metrics.setChainHead(560n);
    expect(metrics.snapshot()).toMatchObject({ indexerHeadBlock: 500, chainHeadBlock: 560, indexerLagBlocks: 60 });
    metrics.setIndexerHead(560);
    expect(await valueOf(metrics.registry, metrics.names.indexerLag)).toBe(0);
    expect(await valueOf(metrics.registry, metrics.names.indexerHead)).toBe(560);
    expect(await valueOf(metrics.registry, metrics.names.chainHead)).toBe(560);
  });

  it("keeps the lag gauge at its default until both heads are sampled", async () => {
    const metrics = createMetrics({ service: "indexer", defaultMetrics: false });
    metrics.setIndexerHead(500);
    expect(await valueOf(metrics.registry, metrics.names.indexerLag)).toBe(0);
    expect(await valueOf(metrics.registry, metrics.names.indexerHead)).toBe(500);
    expect(indexerLagging().evaluate({ ...metrics.snapshot() }, { now: 0 })).toEqual({ firing: false, detail: "no lag sample" });
  });

  it("times proofs and counts attempts and failures", async () => {
    const metrics = createMetrics({ service: "prover", defaultMetrics: false });
    const ok = metrics.startProof();
    expect(ok.success()).toBeGreaterThanOrEqual(0);
    expect(ok.success()).toBeGreaterThanOrEqual(0);
    const failed = metrics.startProof();
    failed.failure("witness calculation failed");
    expect(metrics.snapshot()).toMatchObject({ proofAttempts: 2, proofFailures: 1 });
    expect(await valueOf(metrics.registry, `${metrics.names.proofDuration}_count`)).toBe(2);
    expect(await valueOf(metrics.registry, metrics.names.proofFailures, { reason: "witness_failed" })).toBe(1);
  });

  it("tracks keeper actions, failures, failovers, disputes and fees", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    metrics.recordKeeperAction("finalize", "success");
    metrics.recordKeeperAction("finalize", "failure");
    metrics.recordKeeperAction("recordExpiry", "skipped");
    metrics.recordRpcFailover("https://primary.example.com/v2/key", "https://fallback.example.com/rpc?apikey=token");
    metrics.setDisputesOpen(4);
    metrics.addKeeperFeeUsdc(0.5);
    metrics.addKeeperFeeUsdc(0.25);
    expect(metrics.snapshot()).toMatchObject({
      keeperActions: 3,
      keeperFailures: 1,
      rpcFailovers: 1,
      disputesOpen: 4,
      keeperFeeEarnedUsdc: 0.75,
    });
    const { registry, names } = metrics;
    expect(await valueOf(registry, names.keeperActions, { action: "finalize", result: "failure" })).toBe(1);
    expect(await valueOf(registry, names.rpcFailover, { from: "primary.example.com", to: "fallback.example.com" })).toBe(1);
    expect(await valueOf(registry, names.keeperFeeEarned)).toBe(0.75);
    expect(await valueOf(registry, names.disputesOpen)).toBe(4);
  });

  it("ignores non-finite values instead of poisoning the registry", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    metrics.setFinalizePending(2);
    metrics.setFinalizePending(Number.NaN);
    metrics.setOldestPendingAgeSeconds(Number.POSITIVE_INFINITY);
    metrics.observeProofDuration(-1);
    metrics.addKeeperFeeUsdc(-5);
    expect(metrics.snapshot()).toMatchObject({ finalizePending: 2, oldestPendingAgeSeconds: 0, proofAttempts: 0, keeperFeeEarnedUsdc: 0 });
    expect(await valueOf(metrics.registry, metrics.names.finalizePending)).toBe(2);
  });

  it("collects default process metrics unless disabled", async () => {
    const withDefaults = createMetrics({ service: "prover" });
    const text = await renderMetrics(withDefaults.registry);
    expect(text).toContain("process_cpu_seconds_total");
    expect(text).toContain("nodejs_heap_size_total_bytes");
    const without = createMetrics({ service: "prover", defaultMetrics: false });
    expect(await renderMetrics(without.registry)).not.toContain("process_cpu_seconds_total");
  });

  it("returns an independent snapshot copy", () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    const first = metrics.snapshot();
    metrics.setFinalizePending(9);
    expect(first.finalizePending).toBe(0);
    expect(metrics.snapshot().finalizePending).toBe(9);
  });
});

describe("labels stay bounded", () => {
  it("maps every proof failure message onto the published reason set", async () => {
    const metrics = createMetrics({ service: "prover", defaultMetrics: false });
    const messages = [
      "budget_cents: must be a whole number",
      "Missing required field(s): operator_id, policy",
      "ENOENT: no such file or directory, open 'artifacts/payment.zkey'",
      "Circuit produced 4 public signals, expected 6 - circuit and prover service are out of sync.",
      "lookup key is zero; the circuit rejects this witness",
      "request timed out after 30000ms",
      "JavaScript heap out of memory",
      "something nobody has seen before",
    ];
    for (const message of messages) metrics.recordProofFailure(message);
    for (let i = 0; i < 200; i += 1) metrics.recordProofFailure(`snarkjs exploded at offset ${i}`);
    const json = (await metrics.registry.getMetricsAsJSON()) as MetricJson[];
    const failures = json.find((m) => m.name === metrics.names.proofFailures);
    const reasons = [...new Set((failures?.values ?? []).map((v) => String(v.labels.reason)))].sort();
    expect(reasons).toEqual([
      "artifacts_missing",
      "circuit_mismatch",
      "invalid_field",
      "missing_field",
      "out_of_memory",
      "timeout",
      "unknown",
      "witness_failed",
    ]);
    for (const reason of reasons) expect(PROOF_FAILURE_REASONS).toContain(reason);
    expect(metrics.snapshot().proofFailures).toBe(208);
  });

  it("reduces failover endpoints to a host and never carries a credential", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    metrics.recordRpcFailover("https://arc-mainnet.example.com/v2/SECRET_API_KEY_abc123", "https://fallback.example.com/rpc?apikey=SECRET_TOKEN_xyz");
    metrics.recordRpcFailover("not a url", "also not a url");
    const text = await renderMetrics(metrics.registry);
    expect(text).not.toContain("SECRET_API_KEY_abc123");
    expect(text).not.toContain("SECRET_TOKEN_xyz");
    expect(await valueOf(metrics.registry, metrics.names.rpcFailover, { from: "arc-mainnet.example.com", to: "fallback.example.com" })).toBe(1);
    expect(
      await valueOf(metrics.registry, metrics.names.rpcFailover, {
        from: UNPARSABLE_ENDPOINT_LABEL,
        to: UNPARSABLE_ENDPOINT_LABEL,
      }),
    ).toBe(1);
    expect(endpointLabel("https://user:pass@node.example.com:8545/path")).toBe("node.example.com:8545");
  });
});

describe("progress and failure signals the alerting reads", () => {
  it("stamps the last completed keeper tick and starts from process start", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    expect(metrics.snapshot().lastKeeperTickAt).toBeGreaterThan(0);
    metrics.recordKeeperTick(1_700_000_000_000);
    expect(metrics.snapshot().lastKeeperTickAt).toBe(1_700_000_000_000);
    expect(await valueOf(metrics.registry, metrics.names.keeperLastTick)).toBe(1_700_000_000);
  });

  it("measures the gap between the configured finalize gas and the receipt", async () => {
    const metrics = createMetrics({ service: "keeper", defaultMetrics: false });
    metrics.recordFinalizeGas("finalize", 450_000n, 465_486n);
    expect(metrics.snapshot().finalizeGasGap).toBe(-15_486);
    expect(await valueOf(metrics.registry, metrics.names.finalizeGasUsed, { action: "finalize" })).toBe(465_486);
    expect(await valueOf(metrics.registry, metrics.names.finalizeGasGap, { action: "finalize" })).toBe(-15_486);
  });

  it("counts hook write failures, alert dispatch failures and quarantined events", async () => {
    const metrics = createMetrics({ service: "indexer", defaultMetrics: false });
    metrics.recordHookWriteFailure("reputation");
    metrics.recordHookWriteFailure("validation");
    metrics.recordHookWriteFailure("complianceCheck");
    metrics.recordAlertDispatchFailure("indexerLagging", "notify");
    metrics.recordQuarantinedEvent("SquareJob", "JobDescribed");
    expect(metrics.snapshot()).toMatchObject({ hookWriteFailures: 3, alertDispatchFailures: 1, quarantinedEvents: 1 });
    const { registry, names } = metrics;
    expect(await valueOf(registry, names.hookWriteFailures, { kind: "reputation" })).toBe(1);
    expect(await valueOf(registry, names.hookWriteFailures, { kind: "complianceCheck" })).toBe(1);
    expect(await valueOf(registry, names.alertDispatchFailures, { rule: "indexerLagging", stage: "notify" })).toBe(1);
    expect(await valueOf(registry, names.quarantinedEvents, { contract: "SquareJob", event: "JobDescribed" })).toBe(1);
  });
});
