import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { JobStatus, deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, keeperJobState, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createMetrics, type Metrics } from "@squaresdk/observability";
import { Keeper } from "../src/run.js";

const CHAIN = 31337;
const NOW = 1_760_000_000n;
const BUDGET = 2_000n;
const deployment = deploymentFor(CHAIN);

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

function fakeClient(): SquareClient {
  return {
    deployment,
    publicClient: {
      getGasPrice: async () => 22_172_800_000n,
      getBlock: async () => ({ timestamp: NOW }),
      readContract: async () => false,
    },
    getJobRecord: async () => ({ status: JobStatus.Submitted, budget: BUDGET, evaluatorFeeBP: 50, expiredAt: NOW + 86_400_000n }),
    isDisputed: async () => false,
    challengeEndsAt: async () => Number(NOW - 600n),
    finalize: async () => {
      throw new Error("an unprofitable job must never reach the chain");
    },
  } as unknown as SquareClient;
}

function unprofitableJob(jobId: bigint): jobs.JobRecord {
  return {
    chainId: CHAIN,
    jobId,
    client: "0x1111111111111111111111111111111111111111",
    provider: "0x2222222222222222222222222222222222222222" as Hex,
    evaluator: deployment.keeperEvaluator,
    hook: deployment.squareHook,
    description: "translate a document",
    budget: BUDGET,
    status: jobs.JOB_STATUS.submitted,
    expiredAt: NOW + 86_400_000n,
    createdAt: NOW - 3_600n,
    fundedAt: NOW - 3_000n,
    submittedAt: NOW - 1_200n,
    challengeEnd: NOW - 600n,
    platformFeeBp: 250,
    evaluatorFeeBp: 50,
    deliverable: null,
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: null,
    updatedBlock: 1_000n,
    refundReason: null,
  };
}

async function openDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

interface Process {
  keeper: Keeper;
  logs: Recorded[];
  metrics: Metrics;
}

function start(db: Database): Process {
  const logs: Recorded[] = [];
  const metrics = createMetrics({ service: "test-keeper", defaultMetrics: false });
  const keeper = new Keeper({
    db,
    chainId: CHAIN,
    client: fakeClient(),
    logger: recordingLogger(logs),
    metrics,
    minimumMarginBps: 2_000,
    defaultFinalizeGas: 450_000n,
    defaultFinalizeDecidedGas: 500_000n,
    recordExpiries: false,
  });
  return { keeper, logs, metrics };
}

async function skippedRows(db: Database, limit = 100): Promise<number> {
  return (await keeperActions.recent(db, CHAIN, limit)).filter((row) => row.action === "skipped").length;
}

describe("the journal row an unprofitable job costs", () => {
  it("is written once for the job, not once per process: four jobs and three starts stay four rows", async () => {
    const db = await openDatabase();
    try {
      for (const id of [1n, 2n, 3n, 4n]) await jobs.upsert(db, unprofitableJob(id));

      const first = start(db);
      expect((await first.keeper.tick(NOW)).unprofitable).toBe(4);
      await first.keeper.tick(NOW + 15n);
      expect(await skippedRows(db)).toBe(4);

      const second = start(db);
      expect((await second.keeper.tick(NOW + 30n)).unprofitable).toBe(4);
      expect(await skippedRows(db)).toBe(4);

      const third = start(db);
      expect((await third.keeper.tick(NOW + 45n)).unprofitable).toBe(4);
      expect(await skippedRows(db)).toBe(4);

      expect(await skippedRows(db, 8)).toBe(4);
      for (const id of [1n, 2n, 3n, 4n]) {
        expect((await keeperJobState.get(db, CHAIN, id))?.unprofitableJournaledAt).toBeInstanceOf(Date);
      }
    } finally {
      await db.close();
    }
  });

  it("stays written once even after the ninety day sweep takes the row away", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, unprofitableJob(1n));
      const first = start(db);
      await first.keeper.tick(NOW);
      expect(await skippedRows(db)).toBe(1);

      await db.query("update keeper_actions set created_at = now() - interval '91 days'");
      expect(await keeperActions.sweep(db)).toBe(1);

      const restarted = start(db);
      await restarted.keeper.tick(NOW + 15n);

      expect(await skippedRows(db)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("does not silence the restarted process: the log line and the metric are per process, the row is not", async () => {
    const db = await openDatabase();
    try {
      for (const id of [1n, 2n, 3n, 4n]) await jobs.upsert(db, unprofitableJob(id));
      const first = start(db);
      await first.keeper.tick(NOW);
      await first.keeper.tick(NOW + 15n);

      expect(first.logs.filter((entry) => entry.event === "keeper.skipped")).toHaveLength(4);
      expect(first.metrics.snapshot().keeperActions).toBe(4);

      const restarted = start(db);
      await restarted.keeper.tick(NOW + 30n);
      await restarted.keeper.tick(NOW + 45n);

      expect(restarted.logs.filter((entry) => entry.event === "keeper.skipped")).toHaveLength(4);
      expect(restarted.metrics.snapshot().keeperActions).toBe(4);
      expect(await skippedRows(db)).toBe(4);
    } finally {
      await db.close();
    }
  });
});
