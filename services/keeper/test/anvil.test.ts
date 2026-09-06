import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits } from "viem";
import { foundry } from "viem/chains";
import { anvilAccount } from "./anvil.js";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { keeperActions, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger, createMetrics } from "@squaresdk/observability";
import { Indexer } from "@squaresdk/indexer";
import { Keeper } from "../src/run.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return ((await response.json()) as { result?: string }).result === "0x7a69";
  } catch {
    return false;
  }
}

function localDeployment(): SquareDeployment {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "..", "..", "contracts", "deployments", "31337.json");
  if (existsSync(file)) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(31337);
}

const reachable = await anvilReachable();

describe.skipIf(!reachable)("keeper against anvil", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const silent = createLogger({ service: "test", version: "0", sink: () => {} });
  const actor = (index: number) =>
    createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(index) }),
    });
  const client = actor(1);
  const provider = actor(2);
  const cranker = actor(7);
  let db: Database;

  async function submitted(budget: bigint): Promise<bigint> {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { keeper: Date.now() } });
    await provider.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await provider.submit({ jobId, deliverable: hashDeliverable(`keeper ${jobId}`), agentId: 1n });
    return jobId;
  }

  async function syncAll(): Promise<void> {
    const indexer = new Indexer({ db, publicClient, chainId: 31337, deployment, startBlock: 0n, batchBlocks: 500n, logger: silent });
    await indexer.start();
    while (true) {
      const result = await indexer.syncOnce();
      if (result === null || result.toBlock >= result.head) return;
    }
  }

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
  });

  afterAll(async () => {
    await db.close();
  });

  it("finalizes closed windows, skips unprofitable jobs, waits on open ones", async () => {
    const rich = await submitted(parseUnits("50", 6));
    const poor = await submitted(2_000n);
    const end = await client.challengeEndsAt(poor);
    const latest = await publicClient.getBlock();
    await testClient.increaseTime({ seconds: Number(BigInt(end) - latest.timestamp + 1n) });
    await testClient.mine({ blocks: 1 });
    const fresh = await submitted(parseUnits("50", 6));
    await syncAll();

    const metrics = createMetrics({ service: "test", defaultMetrics: false });
    const keeper = new Keeper({
      db,
      chainId: 31337,
      client: cranker,
      logger: silent,
      metrics,
      minimumMarginBps: 2000,
      defaultFinalizeGas: 450_000n,
      defaultFinalizeDecidedGas: 500_000n,
      recordExpiries: false,
    });
    const before = await cranker.usdcBalance(cranker.account);
    const now = (await publicClient.getBlock()).timestamp;
    const report = await keeper.tick(now);

    expect(report.finalized).toContain(rich);
    expect(report.skipped.find((s) => s.jobId === poor)?.reason).toBe("unprofitable");
    expect(report.finalized).not.toContain(fresh);
    expect(report.skipped.find((s) => s.jobId === fresh)).toBeUndefined();
    expect((await client.getJobRecord(fresh)).status).toBe(JobStatus.Submitted);
    expect((await client.getJobRecord(rich)).status).toBe(JobStatus.Completed);
    expect((await client.getJobRecord(poor)).status).toBe(JobStatus.Submitted);
    const actions = await keeperActions.recent(db, 31337);
    const earned = actions.filter((a) => a.action === "finalize").reduce((sum, a) => sum + (a.feeEarned ?? 0n), 0n);
    expect((await cranker.usdcBalance(cranker.account)) - before).toBe(earned);
    expect(actions.find((a) => a.jobId === rich)?.feeEarned).toBe((parseUnits("50", 6) * 50n) / 10_000n);
    expect(actions.find((a) => a.jobId === rich)?.action).toBe("finalize");
    expect(actions.find((a) => a.jobId === poor)?.action).toBe("skipped");
    expect(metrics.snapshot().keeperActions).toBeGreaterThanOrEqual(1);

    await syncAll();
    const again = await keeper.tick((await publicClient.getBlock()).timestamp);
    expect(again.finalized).toEqual([]);
    expect(again.pending).toBeGreaterThanOrEqual(1);
    expect(again.oldestPendingAgeSeconds).toBeGreaterThan(0);
  }, 120_000);
});
