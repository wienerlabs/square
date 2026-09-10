import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Hex, type Log, type PublicClient } from "viem";
import { deploymentFor, keeperEvaluatorAbi, squareHookAbi, squareJobAbi, type SquareDeployment } from "@squaresdk/core";
import { checkpoints, jobs, ledgerBalances, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createHealth, createMetrics, type Metrics } from "@squaresdk/observability";
import { createApi } from "../src/api.js";
import { indexerChecks } from "../src/checks.js";
import { Indexer } from "../src/sync.js";

const CHAIN = 31337;
const POISON_DESCRIPTION = "spec:\u0000";

const deployment = deploymentFor(CHAIN);
const otherDeployment: SquareDeployment = { ...deployment, squareJob: "0x00000000000000000000000000000000000000AA" };

interface StagedLog {
  abi: Abi;
  address: Hex;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
}

function encode(staged: StagedLog, logIndex: number): Log {
  const item = staged.abi.find((entry) => entry.type === "event" && entry.name === staged.eventName) as AbiEvent;
  const unindexed = item.inputs.filter((input) => input.indexed !== true);
  return {
    address: staged.address,
    topics: encodeEventTopics({ abi: staged.abi, eventName: staged.eventName, args: staged.args } as never),
    data: encodeAbiParameters(unindexed, unindexed.map((input) => staged.args[input.name ?? ""])),
    blockNumber: staged.blockNumber,
    logIndex,
    transactionHash: `0x${logIndex.toString(16).padStart(2, "0").repeat(32)}` as Hex,
    transactionIndex: 0,
    blockHash: `0x${"cd".repeat(32)}` as Hex,
    removed: false,
  } as Log;
}

function chainOf(staged: StagedLog[], head: bigint): PublicClient {
  const logs = staged.map((entry, index) => encode(entry, index));
  return {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter((log) => (log.blockNumber ?? 0n) >= fromBlock && (log.blockNumber ?? 0n) <= toBlock),
  } as unknown as PublicClient;
}

function windowsConfigured(blockNumber: bigint): StagedLog {
  return {
    abi: keeperEvaluatorAbi as Abi,
    address: deployment.keeperEvaluator,
    eventName: "WindowsConfigured",
    args: { effectiveFrom: 0, challengeWindow: 86_400, disputeWindow: 259_200 },
    blockNumber,
  };
}

function jobCreated(jobId: bigint, blockNumber: bigint): StagedLog {
  return {
    abi: squareJobAbi as Abi,
    address: deployment.squareJob,
    eventName: "JobCreated",
    args: {
      jobId,
      client: "0x1111111111111111111111111111111111111111",
      provider: "0x2222222222222222222222222222222222222222",
      evaluator: deployment.keeperEvaluator,
      expiredAt: 1_800_000_000n,
      hook: deployment.squareHook,
    },
    blockNumber,
  };
}

function jobDescribed(jobId: bigint, description: string, blockNumber: bigint): StagedLog {
  return {
    abi: squareJobAbi as Abi,
    address: deployment.squareJob,
    eventName: "JobDescribed",
    args: { jobId, createdAt: 1_700_000_000, description },
    blockNumber,
  };
}

function paymentReleased(jobId: bigint, amount: bigint, blockNumber: bigint): StagedLog {
  return {
    abi: squareJobAbi as Abi,
    address: deployment.squareJob,
    eventName: "PaymentReleased",
    args: { jobId, provider: "0x2222222222222222222222222222222222222222", amount },
    blockNumber,
  };
}

function submissionTimed(jobId: bigint, blockNumber: bigint): StagedLog {
  return {
    abi: squareJobAbi as Abi,
    address: deployment.squareJob,
    eventName: "SubmissionTimed",
    args: { jobId, submittedAt: 1_700_000_100, expiredAt: 1_800_000_000 },
    blockNumber,
  };
}

function reputationWriteFailed(jobId: bigint, blockNumber: bigint): StagedLog {
  return {
    abi: squareHookAbi as Abi,
    address: deployment.squareHook,
    eventName: "ReputationWriteFailed",
    args: { jobId, agentId: 7n, reason: "0xdeadbeef" },
    blockNumber,
  };
}

function validationWriteFailed(jobId: bigint, blockNumber: bigint): StagedLog {
  return {
    abi: squareHookAbi as Abi,
    address: deployment.squareHook,
    eventName: "ValidationWriteFailed",
    args: { jobId, requestHash: `0x${"11".repeat(32)}` as Hex, reason: "0xdeadbeef" },
    blockNumber,
  };
}

interface Recorded {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

function recordingLogger(sink: Recorded[]) {
  const at = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    sink.push({ level, event, fields });
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => recordingLogger(sink) } as never;
}

async function openDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

interface Built {
  indexer: Indexer;
  metrics: Metrics;
  logs: Recorded[];
}

function build(db: Database, staged: StagedLog[], head: bigint, overrides: Partial<ConstructorParameters<typeof Indexer>[0]> = {}): Built {
  const logs: Recorded[] = [];
  const metrics = createMetrics({ service: "test-indexer", defaultMetrics: false });
  const indexer = new Indexer({
    db,
    publicClient: chainOf(staged, head),
    chainId: CHAIN,
    deployment,
    startBlock: 0n,
    batchBlocks: 500n,
    logger: recordingLogger(logs),
    metrics,
    ...overrides,
  });
  return { indexer, metrics, logs };
}

describe("a poison event cannot stop the indexer", () => {
  it("indexes a description carrying a null character and advances the checkpoint", async () => {
    const db = await openDatabase();
    try {
      const staged = [windowsConfigured(1n), jobCreated(1n, 2n), jobDescribed(1n, POISON_DESCRIPTION, 2n), jobCreated(2n, 3n)];
      const { indexer, logs } = build(db, staged, 3n);
      await indexer.start();

      const result = await indexer.syncOnce();

      expect(result?.applied).toBe(4);
      expect(result?.quarantined).toBe(0);
      expect(indexer.lastIndexedBlock).toBe(3n);
      expect((await checkpoints.get(db, CHAIN, "SquareJob"))?.lastBlock).toBe(3n);
      const mirrored = await jobs.get(db, CHAIN, 1n);
      expect(mirrored?.description).not.toContain(POISON_DESCRIPTION);
      expect(mirrored?.description.startsWith("spec:")).toBe(true);
      expect(await jobs.get(db, CHAIN, 2n)).not.toBeNull();
      expect(logs.filter((entry) => entry.event === "indexer.event_quarantined")).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("sets aside an event the reducer rejects, applies the rest of the batch and keeps moving", async () => {
    const db = await openDatabase();
    try {
      const staged = [
        windowsConfigured(1n),
        jobDescribed(404n, "an event for a job we never saw created", 2n),
        jobCreated(1n, 2n),
        jobDescribed(1n, "translate a document", 2n),
      ];
      const { indexer, metrics, logs } = build(db, staged, 2n);
      await indexer.start();

      const result = await indexer.syncOnce();

      expect(result?.quarantined).toBe(1);
      expect(result?.applied).toBe(3);
      expect(indexer.lastIndexedBlock).toBe(2n);
      expect((await checkpoints.get(db, CHAIN, "SquareJob"))?.lastBlock).toBe(2n);
      expect((await jobs.get(db, CHAIN, 1n))?.description).toBe("translate a document");
      expect(indexer.quarantinedEvents).toHaveLength(1);
      expect(indexer.quarantinedEvents[0]).toMatchObject({ contract: "SquareJob", eventName: "JobDescribed", stage: "reduce" });
      expect(metrics.snapshot().quarantinedEvents).toBe(1);
      expect(logs.some((entry) => entry.event === "indexer.event_quarantined" && entry.level === "error")).toBe(true);

      const health = createHealth({
        service: "t",
        version: "0",
        checks: {
          quarantine: () => ({ ok: indexer.quarantinedEvents.length === 0, detail: `${indexer.quarantinedEvents.length} events set aside` }),
        },
      });
      const api = createApi({ db, chainId: CHAIN, indexer, health, metrics });
      const status = (await (await api.request("/status")).json()) as { quarantined: number };
      expect(status.quarantined).toBe(1);
      const quarantined = (await (await api.request("/quarantine")).json()) as unknown[];
      expect(quarantined).toHaveLength(1);
      expect((await (await api.request("/health")).json()).status).toBe("degraded");
    } finally {
      await db.close();
    }
  });
});

describe("a rolled-back batch", () => {
  it("leaves the in-memory state clean and applies exactly once on the retry", async () => {
    const db = await openDatabase();
    try {
      const staged = [windowsConfigured(1n), jobCreated(1n, 2n), jobDescribed(1n, "translate a document", 2n), paymentReleased(1n, 5_000_000n, 2n)];
      let failCheckpoint = true;
      const faulty: Database = {
        query: (text, params) => db.query(text, params),
        close: () => db.close(),
        transaction: (fn) =>
          db.transaction((tx) =>
            fn({
              query: (text, params) => {
                if (failCheckpoint && text.includes("indexer_checkpoints")) return Promise.reject(new Error("connection reset by peer"));
                return tx.query(text, params);
              },
              transaction: tx.transaction,
              close: tx.close,
            }),
          ),
      };

      const { indexer } = build(faulty, staged, 2n);
      await indexer.start();

      await expect(indexer.syncOnce()).rejects.toThrow("connection reset by peer");
      expect(indexer.state.jobs.size).toBe(0);
      expect(indexer.state.ledger.size).toBe(0);
      expect(indexer.state.windows).toHaveLength(0);
      expect(indexer.lastIndexedBlock).toBe(null);
      expect(await jobs.get(db, CHAIN, 1n)).toBe(null);

      failCheckpoint = false;
      const result = await indexer.syncOnce();

      expect(result?.applied).toBe(4);
      expect(indexer.state.jobs.size).toBe(1);
      expect(indexer.state.ledger.get("SquareJob:0x2222222222222222222222222222222222222222")).toBe(5_000_000n);
      const balance = await ledgerBalances.get(db, CHAIN, "SquareJob", "0x2222222222222222222222222222222222222222");
      expect(balance?.amount).toBe(5_000_000n);
    } finally {
      await db.close();
    }
  });
});

describe("a checkpoint from another deployment", () => {
  it("refuses to start rather than skipping the new contracts", async () => {
    const db = await openDatabase();
    try {
      for (const contract of ["SquareJob", "KeeperEvaluator", "Arbitration", "ClaimMarket", "SquareHook"] as const) {
        await checkpoints.set(db, { chainId: CHAIN, contract, address: otherDeployment.squareJob, lastBlock: 900n });
      }
      const { indexer } = build(db, [], 1_000n);
      await expect(indexer.start()).rejects.toThrow(/different deployment/);
    } finally {
      await db.close();
    }
  });

  it("reindexes from the start block when the operator asks for a restart", async () => {
    const db = await openDatabase();
    try {
      await checkpoints.set(db, { chainId: CHAIN, contract: "SquareJob", address: otherDeployment.squareJob, lastBlock: 900n });
      const staged = [windowsConfigured(1n), jobCreated(1n, 2n)];
      const { indexer, logs } = build(db, staged, 2n, { onDeploymentChange: "restart" });

      await indexer.start();

      expect(indexer.lastIndexedBlock).toBe(null);
      expect(logs.some((entry) => entry.event === "indexer.deployment_changed" && entry.level === "warn")).toBe(true);
      const result = await indexer.syncOnce();
      expect(result?.fromBlock).toBe(0n);
      expect(result?.applied).toBe(2);
      expect((await checkpoints.get(db, CHAIN, "SquareJob"))?.address.toLowerCase()).toBe(deployment.squareJob.toLowerCase());
    } finally {
      await db.close();
    }
  });
});

describe("signals the operator can act on", () => {
  it("warns when a submission is timed with no configured window", async () => {
    const db = await openDatabase();
    try {
      const staged = [jobCreated(1n, 2n), submissionTimed(1n, 3n)];
      const { indexer, logs } = build(db, staged, 3n);
      await indexer.start();
      await indexer.syncOnce();

      const warning = logs.find((entry) => entry.event === "indexer.windows_missing");
      expect(warning?.level).toBe("warn");
      expect(String(warning?.fields.reason)).toContain("START_BLOCK");
      expect(indexer.missingWindowEvents).toBe(1);
      expect((await jobs.get(db, CHAIN, 1n))?.challengeEnd).toBe(null);
    } finally {
      await db.close();
    }
  });

  it("counts the hook registry writes that failed, once, and not again on replay", async () => {
    const db = await openDatabase();
    try {
      const staged = [jobCreated(1n, 2n), reputationWriteFailed(1n, 3n), validationWriteFailed(1n, 3n)];
      const first = build(db, staged, 3n);
      await first.indexer.start();
      await first.indexer.syncOnce();

      expect(first.metrics.snapshot().hookWriteFailures).toBe(2);
      expect(first.logs.filter((entry) => entry.event === "indexer.hook_write_failed")).toHaveLength(2);

      const second = build(db, staged, 3n);
      await second.indexer.start();
      expect(second.metrics.snapshot().hookWriteFailures).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("reports a stalled indexer as unhealthy instead of 200", async () => {
    const db = await openDatabase();
    try {
      const staged = [jobCreated(1n, 2n)];
      const { indexer, metrics } = build(db, staged, 5_000n, { batchBlocks: 2n });
      await indexer.start();
      await indexer.syncOnce();

      const health = createHealth({
        service: "square-indexer",
        version: "0",
        checks: indexerChecks({
          db,
          publicClient: { getChainId: async () => CHAIN },
          chainId: CHAIN,
          indexer,
          maxLagBlocks: 100n,
          maxSyncAgeMs: 120_000,
          startupGraceMs: 60_000,
        }),
      });
      const api = createApi({ db, chainId: CHAIN, indexer, health, metrics });
      const response = await api.request("/health");
      expect(response.status).toBe(503);
      const body = (await response.json()) as { status: string; checks: Record<string, { ok: boolean; detail?: string }> };
      expect(body.status).toBe("unhealthy");
      expect(body.checks["lag"]).toMatchObject({ ok: false, detail: "4999 blocks behind, limit 100" });
    } finally {
      await db.close();
    }
  });
});
