import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { JobStatus, deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createMetrics } from "@squaresdk/observability";
import { Keeper } from "../src/run.js";

const CHAIN = 31337;
const NOW = 1_760_000_000n;
const deployment = deploymentFor(CHAIN);
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
  finalizeCalls: bigint[];
  recordCalls: bigint[];
  onFinalize: () => void;
  onRecord: () => void;
}

function fakeClient(chain: FakeChain): SquareClient {
  return {
    deployment,
    publicClient: {
      getGasPrice: async () => 22_172_800_000n,
      getBlock: async () => ({ timestamp: NOW }),
      readContract: async () => false,
    },
    getJobRecord: async () => ({ status: JobStatus.Submitted, budget: 25_000_000n, evaluatorFeeBP: 50, expiredAt: NOW + 86_400n }),
    isDisputed: async () => false,
    challengeEndsAt: async () => Number(NOW - 600n),
    finalize: async (jobId: bigint) => {
      chain.onFinalize();
      chain.finalizeCalls.push(jobId);
      return { hash: txHash, receipt: { gasUsed: 465_486n }, events: [] };
    },
    recordExpiry: async (jobId: bigint) => {
      chain.onRecord();
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
    provider: "0x2222222222222222222222222222222222222222",
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
    refundReason: null,
    ...overrides,
  };
}

interface Pool {
  handle: Database;
  refused: number;
  close: () => void;
}

function poolThatRefusesUseAfterClose(inner: Database): Pool {
  let closed = false;
  const pool: Pool = {
    refused: 0,
    close: () => {
      closed = true;
    },
    handle: {
      query: async (text: string, params?: unknown[]) => {
        if (closed) {
          pool.refused += 1;
          throw new Error("Cannot use a pool after calling end on the pool");
        }
        return inner.query(text, params);
      },
      transaction: async (fn) => inner.transaction(fn),
      close: async () => {
        closed = true;
      },
    } as Database,
  };
  return pool;
}

async function openDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

function build(db: Database, chain: FakeChain, overrides: Partial<ConstructorParameters<typeof Keeper>[0]> = {}): { keeper: Keeper; logs: Recorded[] } {
  const logs: Recorded[] = [];
  const keeper = new Keeper({
    db,
    chainId: CHAIN,
    client: fakeClient(chain),
    logger: recordingLogger(logs),
    metrics: createMetrics({ service: "test-keeper", defaultMetrics: false }),
    minimumMarginBps: 0,
    defaultFinalizeGas: 450_000n,
    defaultFinalizeDecidedGas: 500_000n,
    recordExpiries: true,
    ...overrides,
  });
  return { keeper, logs };
}

describe("a SIGTERM that lands in the middle of a tick", () => {
  it("lets the tick finish and journal what it sent before the pool is closed", async () => {
    const inner = await openDatabase();
    const pool = poolThatRefusesUseAfterClose(inner);
    try {
      await jobs.upsert(inner, job({ jobId: 1n }));
      const controller = new AbortController();
      const chain: FakeChain = {
        finalizeCalls: [],
        recordCalls: [],
        onFinalize: () => controller.abort(),
        onRecord: () => {},
      };
      const { keeper, logs } = build(pool.handle, chain, { recordExpiries: false });

      await keeper.run(20, controller.signal);
      pool.close();

      expect(chain.finalizeCalls).toEqual([1n]);
      expect(pool.refused).toBe(0);
      const journal = await keeperActions.recent(inner, CHAIN, 10);
      expect(journal).toHaveLength(1);
      expect(journal[0]?.action).toBe("finalize");
      expect(journal[0]?.txHash).toBe(txHash);
      expect(logs.filter((entry) => entry.event === "keeper.tick_failed")).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.finalized")).toHaveLength(1);
    } finally {
      await inner.close();
    }
  });

  it("does not start the expiry sweep after the abort", async () => {
    const inner = await openDatabase();
    const pool = poolThatRefusesUseAfterClose(inner);
    try {
      await jobs.upsert(inner, job({ jobId: 1n }));
      await jobs.upsert(inner, job({ jobId: 2n, status: jobs.JOB_STATUS.expired, challengeEnd: null, agentId: 892_531n }));
      const controller = new AbortController();
      const chain: FakeChain = {
        finalizeCalls: [],
        recordCalls: [],
        onFinalize: () => controller.abort(),
        onRecord: () => {},
      };
      const { keeper, logs } = build(pool.handle, chain);

      await keeper.run(20, controller.signal);
      pool.close();

      expect(chain.recordCalls).toEqual([]);
      expect(pool.refused).toBe(0);
      expect((await keeperActions.recent(inner, CHAIN, 10)).map((row) => row.action)).toEqual(["finalize"]);
      expect(logs.filter((entry) => entry.event === "keeper.expiry_sweep_failed")).toEqual([]);
    } finally {
      await inner.close();
    }
  });

  it("is the only reason that sweep did not run: without the abort the same tick sweeps", async () => {
    const inner = await openDatabase();
    try {
      await jobs.upsert(inner, job({ jobId: 1n }));
      await jobs.upsert(inner, job({ jobId: 2n, status: jobs.JOB_STATUS.expired, challengeEnd: null, agentId: 892_531n }));
      const controller = new AbortController();
      const chain: FakeChain = {
        finalizeCalls: [],
        recordCalls: [],
        onFinalize: () => {},
        onRecord: () => controller.abort(),
      };
      const { keeper } = build(inner, chain);

      await keeper.run(20, controller.signal);

      expect(chain.finalizeCalls).toEqual([1n]);
      expect(chain.recordCalls).toEqual([2n]);
    } finally {
      await inner.close();
    }
  });
});
