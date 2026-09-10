import { describe, it, expect } from "vitest";
import type { Database } from "@squaresdk/data";
import { createHealth, type CheckReport, type HealthStatus } from "@squaresdk/observability";
import { indexerChecks, type SyncProgress } from "../src/checks.js";

const CHAIN = 5042002;
const BOOT = 1_700_000_000_000;
const DEPLOYMENT_BLOCK = 60_823_791n;
const MAX_LAG_BLOCKS = 100n;
const MAX_SYNC_AGE_MS = 120_000;
const STARTUP_GRACE_MS = 60_000;

interface Fakes {
  rowCount?: number;
  chainId?: number;
}

function progress(overrides: Partial<SyncProgress> = {}): SyncProgress {
  return { lastIndexedBlock: null, sampledChainHead: null, lastSyncAt: null, quarantinedEvents: [], ...overrides };
}

function harness(indexer: SyncProgress, fakes: Fakes = {}) {
  let now = BOOT;
  const db = { query: async () => ({ rows: [], rowCount: fakes.rowCount ?? 1 }) } as unknown as Database;
  const publicClient = { getChainId: async () => fakes.chainId ?? CHAIN };
  const health = createHealth({
    service: "square-indexer",
    version: "0",
    checks: indexerChecks({
      db,
      publicClient,
      chainId: CHAIN,
      indexer,
      maxLagBlocks: MAX_LAG_BLOCKS,
      maxSyncAgeMs: MAX_SYNC_AGE_MS,
      startupGraceMs: STARTUP_GRACE_MS,
      now: () => now,
    }),
  });
  return {
    advance(ms: number): void {
      now += ms;
    },
    status: (): Promise<HealthStatus> => health.status(),
  };
}

function lagOf(status: HealthStatus): CheckReport {
  const report = status.checks["lag"];
  if (report === undefined) throw new Error("the health report carries no lag check");
  return report;
}

describe("the lag check reports what it measured", () => {
  it("says it has not measured yet on an empty database that never synced, and fails after the grace", async () => {
    const h = harness(progress());

    const early = await h.status();
    expect(lagOf(early)).toMatchObject({ ok: true, critical: true });
    expect(lagOf(early).detail).toContain("not measured yet, neither head has been sampled");
    expect(lagOf(early).detail).not.toContain("0 blocks behind");
    expect(early.status).toBe("healthy");

    h.advance(STARTUP_GRACE_MS + 1_000);
    const late = await h.status();
    expect(lagOf(late).ok).toBe(false);
    expect(lagOf(late).detail).toContain("61s since start, grace 60s");
    expect(late.status).toBe("unhealthy");
  });

  it("never prints a negative lag on a checkpointed restart", async () => {
    const h = harness(progress({ lastIndexedBlock: DEPLOYMENT_BLOCK }));

    const early = await h.status();
    expect(lagOf(early).ok).toBe(true);
    expect(lagOf(early).detail).toContain("not measured yet, the chain head has not been sampled");
    expect(lagOf(early).detail).not.toContain("-");
    expect(early.status).toBe("healthy");

    h.advance(STARTUP_GRACE_MS + 1_000);
    const late = await h.status();
    expect(lagOf(late).ok).toBe(false);
    expect(lagOf(late).detail).not.toContain("-");
    expect(late.status).toBe("unhealthy");
  });

  it("measures the distance between the two heads on a normal run", async () => {
    const caughtUp = harness(progress({ lastIndexedBlock: DEPLOYMENT_BLOCK, sampledChainHead: DEPLOYMENT_BLOCK + 9n, lastSyncAt: BOOT }));
    const status = await caughtUp.status();
    expect(lagOf(status)).toMatchObject({ ok: true, detail: "9 blocks behind, limit 100" });
    expect(status.status).toBe("healthy");

    const behind = harness(progress({ lastIndexedBlock: DEPLOYMENT_BLOCK, sampledChainHead: DEPLOYMENT_BLOCK + 4_000n, lastSyncAt: BOOT }));
    const lagging = await behind.status();
    expect(lagOf(lagging)).toMatchObject({ ok: false, detail: "4000 blocks behind, limit 100" });
    expect(lagging.status).toBe("unhealthy");
  });

  it("fails a frozen loop, where both heads stopped moving together", async () => {
    const h = harness(progress({ lastIndexedBlock: DEPLOYMENT_BLOCK, sampledChainHead: DEPLOYMENT_BLOCK, lastSyncAt: BOOT }));

    const moving = await h.status();
    expect(lagOf(moving)).toMatchObject({ ok: true, detail: "0 blocks behind, limit 100" });

    h.advance(MAX_SYNC_AGE_MS + 1_000);
    const frozen = await h.status();
    expect(lagOf(frozen).ok).toBe(false);
    expect(lagOf(frozen).detail).toBe("the last sync finished 121s ago, limit 120s");
    expect(frozen.status).toBe("unhealthy");
  });

  it("fails a mirror that claims blocks the chain does not have", async () => {
    const h = harness(progress({ lastIndexedBlock: DEPLOYMENT_BLOCK, sampledChainHead: DEPLOYMENT_BLOCK - 5n, lastSyncAt: BOOT }));

    const status = await h.status();
    expect(lagOf(status)).toMatchObject({ ok: false, detail: "the indexed head is 5 blocks ahead of the chain head" });
    expect(status.status).toBe("unhealthy");
  });
});

describe("the database and rpc checks", () => {
  const running = progress({ lastIndexedBlock: DEPLOYMENT_BLOCK, sampledChainHead: DEPLOYMENT_BLOCK, lastSyncAt: BOOT });

  it("pass against a database that answers and an endpoint on the configured chain", async () => {
    const status = await harness(running).status();

    expect(status.checks["database"]).toMatchObject({ ok: true, critical: true });
    expect(status.checks["rpc"]).toMatchObject({ ok: true, critical: true });
    expect(status.checks["quarantine"]).toMatchObject({ ok: true, detail: "no event set aside" });
    expect(status.status).toBe("healthy");
  });

  it("fail when the database returns no row or the endpoint answers for another chain", async () => {
    const noRow = await harness(running, { rowCount: 0 }).status();
    expect(noRow.checks["database"]).toMatchObject({ ok: false, critical: true });
    expect(noRow.status).toBe("unhealthy");

    const otherChain = await harness(running, { chainId: 31337 }).status();
    expect(otherChain.checks["rpc"]).toMatchObject({ ok: false, critical: true });
    expect(otherChain.status).toBe("unhealthy");
  });
});
