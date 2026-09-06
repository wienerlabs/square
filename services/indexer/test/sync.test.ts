import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, squareJobAbi, type SquareDeployment } from "@squaresdk/core";
import { checkpoints, jobs, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createHealth, createLogger, createMetrics } from "@squaresdk/observability";
import { createApi } from "../src/api.js";
import { Indexer } from "../src/sync.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;

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

describe.skipIf(!reachable)("indexer sync against anvil with a PGlite journal", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const logger = createLogger({ service: "test-indexer", version: "0", sink: () => {} });
  const actor = (index: number) =>
    createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(keys[index] as Hex) }),
    });
  const client = actor(1);
  const provider = actor(2);
  let db: Database;

  function indexer(database: Database): Indexer {
    return new Indexer({ db: database, publicClient, chainId: 31337, deployment, startBlock: 0n, batchBlocks: 500n, logger, metrics: createMetrics({ service: "test", defaultMetrics: false }) });
  }

  async function syncAll(instance: Indexer): Promise<void> {
    while (true) {
      const result = await instance.syncOnce();
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

  it("syncs from block zero, persists the mirror and serves the query surface", async () => {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { indexer: "sync" } });
    await provider.setBudget(jobId, parseUnits("12", 6));
    await client.fund(jobId, parseUnits("12", 6));
    await provider.submit({ jobId, deliverable: hashDeliverable("indexed"), agentId: 1n });

    const first = indexer(db);
    await first.start();
    await syncAll(first);

    const mirrored = await jobs.get(db, 31337, jobId);
    const chain = await publicClient.readContract({ abi: squareJobAbi, address: deployment.squareJob, functionName: "getJobRecord", args: [jobId] });
    expect(mirrored?.status).toBe(2);
    expect(mirrored?.budget).toBe(chain.budget);
    expect(mirrored?.submittedAt).toBe(BigInt(chain.submittedAt));
    expect(mirrored?.challengeEnd).toBe(BigInt(chain.submittedAt) + 86_400n);
    expect(mirrored?.agentId).toBe(1n);
    const checkpoint = await checkpoints.get(db, 31337, "SquareJob");
    expect(checkpoint?.lastBlock).toBe(await publicClient.getBlockNumber());

    const api = createApi({ db, chainId: 31337, indexer: first, health: createHealth({ service: "t", version: "0" }), metrics: createMetrics({ service: "t", defaultMetrics: false }) });
    const inWindow = (await (await api.request("/jobs/in-window")).json()) as Array<{ jobId: string }>;
    expect(inWindow.map((j) => j.jobId)).toContain(jobId.toString());
    const byProvider = (await (await api.request(`/jobs/provider/${provider.account}`)).json()) as Array<{ jobId: string }>;
    expect(byProvider.map((j) => j.jobId)).toContain(jobId.toString());
    const one = (await (await api.request(`/jobs/${jobId}`)).json()) as { job: { description: string } };
    expect(one.job.description.startsWith("spec:0x")).toBe(true);
    expect((await api.request("/health")).status).toBe(200);
    expect((await api.request("/metrics")).headers.get("content-type")).toContain("text/plain");
    expect((await api.request("/jobs/999999")).status).toBe(404);
  }, 120_000);

  it("resumes from the checkpoint after a restart and never double-applies", async () => {
    const before = await checkpoints.get(db, 31337, "SquareJob");
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { indexer: "resume" } });
    await provider.setBudget(jobId, parseUnits("5", 6));
    await client.fund(jobId, parseUnits("5", 6));
    await provider.submit({ jobId, deliverable: hashDeliverable("resumed"), agentId: 1n });
    await testClient.mine({ blocks: 2 });

    const second = indexer(db);
    await second.start();
    expect(second.lastIndexedBlock).toBe(before?.lastBlock ?? null);
    expect(second.state.jobs.size).toBeGreaterThan(0);
    const result = await second.syncOnce();
    expect(result?.fromBlock).toBe((before?.lastBlock ?? -1n) + 1n);
    await syncAll(second);

    const { rows } = await db.query<{ n: string }>("select count(*)::text as n from job_events where chain_id = 31337");
    const journalSize = Number(rows[0]?.n);
    const third = indexer(db);
    await third.start();
    await syncAll(third);
    const again = await db.query<{ n: string }>("select count(*)::text as n from job_events where chain_id = 31337");
    expect(Number(again.rows[0]?.n)).toBe(journalSize);
    expect(third.state.jobs.get(jobId)?.status).toBe(2);
    const mirrored = await jobs.get(db, 31337, jobId);
    expect(mirrored?.status).toBe(2);
    expect(second.state.jobs.size).toBe(third.state.jobs.size);
  }, 120_000);
});
