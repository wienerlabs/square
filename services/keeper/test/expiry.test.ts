import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { JobStatus, deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createMetrics, type Metrics } from "@squaresdk/observability";
import { Keeper } from "../src/run.js";

const CHAIN = 31337;
const NOW = 1_760_000_000n;
const deployment = deploymentFor(CHAIN);
const provider: Hex = "0x2222222222222222222222222222222222222222";
const txHash = `0x${"ab".repeat(32)}` as Hex;

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

interface FakeChain {
  reads: bigint[];
  recordCalls: bigint[];
  recordedOnChain: Set<bigint>;
  expiredAt: bigint;
}

function newChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return { reads: [], recordCalls: [], recordedOnChain: new Set(), expiredAt: NOW + 86_400_000n, ...overrides };
}

function fakeClient(chain: FakeChain): SquareClient {
  return {
    deployment,
    publicClient: {
      getGasPrice: async () => 25_000_000_000n,
      readContract: async ({ args }: { args: readonly [bigint] }) => {
        chain.reads.push(args[0]);
        return chain.recordedOnChain.has(args[0]);
      },
    },
    getJobRecord: async () => ({ status: JobStatus.Submitted, budget: 1_000n, evaluatorFeeBP: 50, expiredAt: chain.expiredAt }),
    isDisputed: async () => false,
    challengeEndsAt: async () => NOW - 600n,
    recordExpiry: async (jobId: bigint) => {
      chain.recordCalls.push(jobId);
      return { hash: txHash, receipt: { gasUsed: 47_953n }, events: [] };
    },
  } as unknown as SquareClient;
}

function job(overrides: Partial<jobs.JobRecord>): jobs.JobRecord {
  return {
    chainId: CHAIN,
    jobId: 1n,
    client: "0x1111111111111111111111111111111111111111",
    provider,
    evaluator: deployment.keeperEvaluator,
    hook: deployment.squareHook,
    description: "translate a document",
    budget: 1_000n,
    status: jobs.JOB_STATUS.submitted,
    expiredAt: NOW + 86_400n,
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
    ...overrides,
  };
}

function expiredJob(jobId: bigint): jobs.JobRecord {
  return job({ jobId, status: jobs.JOB_STATUS.expired, challengeEnd: null, agentId: 892_531n });
}

async function openDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

interface Built {
  keeper: Keeper;
  metrics: Metrics;
  logs: Recorded[];
}

function build(db: Database, chain: FakeChain, overrides: Partial<ConstructorParameters<typeof Keeper>[0]> = {}): Built {
  const logs: Recorded[] = [];
  const metrics = createMetrics({ service: "test-keeper", defaultMetrics: false });
  const keeper = new Keeper({
    db,
    chainId: CHAIN,
    client: fakeClient(chain),
    logger: recordingLogger(logs),
    metrics,
    minimumMarginBps: 2_000,
    defaultFinalizeGas: 450_000n,
    defaultFinalizeDecidedGas: 500_000n,
    recordExpiries: true,
    ...overrides,
  });
  return { keeper, metrics, logs };
}

describe("the near-expiry warning", () => {
  it("fires once for a candidate that stays in the set, and again only after it left", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain = newChain({ expiredAt: NOW + 3_600n });
      const { keeper, logs } = build(db, chain);

      let now = NOW;
      for (let tick = 0; tick < 20; tick += 1) {
        const report = await keeper.tick(now);
        expect(report.nearExpiry).toEqual([1n]);
        expect(report.skipped).toEqual([{ jobId: 1n, reason: "unprofitable" }]);
        now += 15n;
      }

      const warnings = logs.filter((entry) => entry.event === "keeper.expiry_near");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.level).toBe("warn");
      expect(String(warnings[0]?.fields.reason)).toContain("warning window");

      await db.query("delete from jobs where job_id = $1", ["1"]);
      await keeper.tick(now);
      expect(logs.filter((entry) => entry.event === "keeper.expiry_near")).toHaveLength(1);

      await jobs.upsert(db, job({ jobId: 1n, updatedBlock: 2_000n }));
      await keeper.tick(now);
      expect(logs.filter((entry) => entry.event === "keeper.expiry_near")).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it("says nothing about a job whose expiry already passed", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain = newChain({ expiredAt: NOW - 2_592_000n });
      const { keeper, logs } = build(db, chain);

      const report = await keeper.tick(NOW);

      expect(report.nearExpiry).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.expiry_near")).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

describe("the expiry sweep", () => {
  it("asks the chain nothing during a tick, however many dead jobs are in the mirror", async () => {
    const db = await openDatabase();
    try {
      for (let id = 1n; id <= 10n; id += 1n) await jobs.upsert(db, expiredJob(id));
      const chain = newChain();
      const { keeper } = build(db, chain);

      await keeper.tick(NOW);

      expect(chain.reads).toEqual([]);
      expect(chain.recordCalls).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("spends a fixed budget per sweep and moves on to the next page once a page is journaled", async () => {
    const db = await openDatabase();
    try {
      for (let id = 1n; id <= 10n; id += 1n) await jobs.upsert(db, expiredJob(id));
      const chain = newChain();
      const { keeper } = build(db, chain, { expiryBatchSize: 3 });

      const first = await keeper.sweepExpiries();
      expect(first).toMatchObject({ scanned: 3, recorded: [1n, 2n, 3n], alreadyRecorded: [], failed: [] });
      expect(chain.reads).toEqual([1n, 2n, 3n]);

      const second = await keeper.sweepExpiries();
      expect(second.recorded).toEqual([4n, 5n, 6n]);
      expect(chain.reads).toHaveLength(6);
      expect(chain.recordCalls).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);

      const journaled = await keeperActions.recent(db, CHAIN, 100);
      expect(journaled.filter((row) => row.action === "recordExpiry" && row.txHash === txHash)).toHaveLength(6);
    } finally {
      await db.close();
    }
  });

  it("journals an expiry another keeper already recorded, so the set shrinks instead of being asked again", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, expiredJob(1n));
      const chain = newChain({ recordedOnChain: new Set([1n]) });
      const { keeper, logs } = build(db, chain);

      const first = await keeper.sweepExpiries();
      expect(first).toMatchObject({ scanned: 1, recorded: [], alreadyRecorded: [1n] });
      expect(chain.recordCalls).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.expiry_already_recorded")).toHaveLength(1);

      const second = await keeper.sweepExpiries();
      expect(second).toMatchObject({ scanned: 0, recorded: [], alreadyRecorded: [] });
      expect(chain.reads).toEqual([1n]);
    } finally {
      await db.close();
    }
  });

  it("leaves a failed attempt in the set and counts it", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, expiredJob(1n));
      const chain = newChain();
      const client = fakeClient(chain);
      const failing = {
        ...client,
        recordExpiry: async () => {
          throw new Error("execution reverted: NoAgentBound");
        },
      } as unknown as SquareClient;
      const { keeper, metrics } = build(db, chain, { client: failing });

      const first = await keeper.sweepExpiries();
      expect(first).toMatchObject({ scanned: 1, recorded: [], failed: [1n] });
      expect(metrics.snapshot().keeperFailures).toBeGreaterThan(0);

      const second = await keeper.sweepExpiries();
      expect(second.scanned).toBe(1);
    } finally {
      await db.close();
    }
  });
});
