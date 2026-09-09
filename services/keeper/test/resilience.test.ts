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
  finalize: (jobId: bigint) => Promise<{ hash: Hex; receipt: { gasUsed: bigint }; events: never[] }>;
  calls: bigint[];
}

function fakeClient(chain: FakeChain, budget: bigint): SquareClient {
  return {
    deployment,
    publicClient: {
      getGasPrice: async () => 22_172_800_000n,
      readContract: async () => true,
    },
    getJobRecord: async () => ({ status: JobStatus.Submitted, budget, evaluatorFeeBP: 50, expiredAt: NOW + 86_400n }),
    isDisputed: async () => false,
    challengeEndsAt: async () => NOW - 600n,
    finalize: async (jobId: bigint) => {
      chain.calls.push(jobId);
      return chain.finalize(jobId);
    },
    finalizeDecided: async (jobId: bigint) => {
      chain.calls.push(jobId);
      return chain.finalize(jobId);
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
    budget: 25_000_000n,
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
    ...overrides,
  };
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
  chain: FakeChain;
}

function build(db: Database, chain: FakeChain, overrides: Partial<ConstructorParameters<typeof Keeper>[0]> = {}): Built {
  const logs: Recorded[] = [];
  const metrics = createMetrics({ service: "test-keeper", defaultMetrics: false });
  const keeper = new Keeper({
    db,
    chainId: CHAIN,
    client: fakeClient(chain, 25_000_000n),
    logger: recordingLogger(logs),
    metrics,
    minimumMarginBps: 0,
    defaultFinalizeGas: 450_000n,
    defaultFinalizeDecidedGas: 500_000n,
    recordExpiries: false,
    ...overrides,
  });
  return { keeper, metrics, logs, chain };
}

describe("candidates", () => {
  it("ignores jobs settled by a third-party evaluator", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      await jobs.upsert(db, job({ jobId: 2n, evaluator: "0x9999999999999999999999999999999999999999" }));
      const chain: FakeChain = {
        calls: [],
        finalize: async () => ({ hash: `0x${"ab".repeat(32)}` as Hex, receipt: { gasUsed: 465_486n }, events: [] }),
      };
      const { keeper } = build(db, chain);

      const report = await keeper.tick(NOW);

      expect(report.finalized).toEqual([1n]);
      expect(chain.calls).toEqual([1n]);
    } finally {
      await db.close();
    }
  });

  it("warns on every empty tick when the mirror is private to the process", async () => {
    const db = await openDatabase();
    try {
      const chain: FakeChain = {
        calls: [],
        finalize: async () => ({ hash: `0x${"ab".repeat(32)}` as Hex, receipt: { gasUsed: 1n }, events: [] }),
      };
      const { keeper, logs } = build(db, chain, { ephemeralMirror: true });

      await keeper.tick(NOW);
      await keeper.tick(NOW + 15n);

      const warnings = logs.filter((entry) => entry.event === "keeper.empty_mirror");
      expect(warnings).toHaveLength(2);
      expect(warnings[0]?.level).toBe("warn");
      expect(String(warnings[0]?.fields.reason)).toContain("DATABASE_URL");
    } finally {
      await db.close();
    }
  });
});

describe("a send that keeps failing", () => {
  it("backs off, gives up and writes a bounded number of journal rows", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain: FakeChain = {
        calls: [],
        finalize: async () => {
          throw new Error("execution reverted: NotOurJob");
        },
      };
      const { keeper, logs } = build(db, chain, {
        retryPolicy: { baseDelaySeconds: 60n, maxDelaySeconds: 600n, giveUpAfter: 3, maxJournalRowsPerJob: 3 },
      });

      let now = NOW;
      for (let tick = 0; tick < 40; tick += 1) {
        await keeper.tick(now);
        now += 15n;
      }

      expect(chain.calls).toHaveLength(3);
      const rows = await keeperActions.recent(db, CHAIN, 100);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.reason?.startsWith("gave up after 3 attempts"))).toHaveLength(1);
      expect(logs.filter((entry) => entry.event === "keeper.gave_up")).toHaveLength(1);
      const last = await keeper.tick(now);
      expect(last.skipped).toEqual([{ jobId: 1n, reason: "gaveUp" }]);
    } finally {
      await db.close();
    }
  });

  it("retries once the backoff window has passed and forgets the job after a success", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      let failing = true;
      const chain: FakeChain = {
        calls: [],
        finalize: async () => {
          if (failing) throw new Error("execution reverted: gas estimation failed");
          return { hash: `0x${"cd".repeat(32)}` as Hex, receipt: { gasUsed: 465_486n }, events: [] };
        },
      };
      const { keeper, metrics } = build(db, chain, {
        retryPolicy: { baseDelaySeconds: 60n, maxDelaySeconds: 600n, giveUpAfter: 10, maxJournalRowsPerJob: 3 },
      });

      await keeper.tick(NOW);
      expect((await keeper.tick(NOW + 30n)).skipped).toEqual([{ jobId: 1n, reason: "backoff" }]);
      expect(chain.calls).toHaveLength(1);

      failing = false;
      const report = await keeper.tick(NOW + 61n);

      expect(report.finalized).toEqual([1n]);
      expect(chain.calls).toHaveLength(2);
      expect(metrics.snapshot().finalizeGasGap).toBe(-15_486);
      expect(metrics.snapshot().lastKeeperTickAt).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
