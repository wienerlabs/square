import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { JobStatus, deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, keeperJobState, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createMetrics } from "@squaresdk/observability";
import { Keeper } from "../src/run.js";

const CHAIN = 31337;
const END = 1_760_000_000n;
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
  blockTimestamp: bigint;
  challengeEnd: bigint;
  blocksRead: number;
  disputed: boolean;
  recordedOnChain: boolean;
  finalizeCalls: bigint[];
  lapseCalls: bigint[];
  recordCalls: bigint[];
  revert: string | null;
}

function newChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    blockTimestamp: END,
    challengeEnd: END,
    blocksRead: 0,
    disputed: false,
    recordedOnChain: false,
    finalizeCalls: [],
    lapseCalls: [],
    recordCalls: [],
    revert: null,
    ...overrides,
  };
}

function sent(): { hash: Hex; receipt: { gasUsed: bigint }; events: never[] } {
  return { hash: txHash, receipt: { gasUsed: 465_486n }, events: [] };
}

function fakeClient(chain: FakeChain): SquareClient {
  const refuseOnce = (): void => {
    if (chain.revert === null) return;
    const message = chain.revert;
    chain.revert = null;
    throw new Error(message);
  };
  return {
    deployment,
    publicClient: {
      getGasPrice: async () => 22_172_800_000n,
      getBlock: async () => {
        chain.blocksRead += 1;
        return { timestamp: chain.blockTimestamp };
      },
      readContract: async () => chain.recordedOnChain,
    },
    getJobRecord: async () => ({ status: JobStatus.Submitted, budget: 25_000_000n, evaluatorFeeBP: 50, expiredAt: END + 86_400n }),
    isDisputed: async () => chain.disputed,
    disputeOf: async () => ({ outcome: 0, resolveBy: Number(END), disputedAt: 1, bondSettled: false }),
    challengeEndsAt: async () => Number(chain.challengeEnd),
    finalize: async (jobId: bigint) => {
      refuseOnce();
      chain.finalizeCalls.push(jobId);
      return sent();
    },
    lapse: async (jobId: bigint) => {
      refuseOnce();
      chain.lapseCalls.push(jobId);
      return sent();
    },
    recordExpiry: async (jobId: bigint) => {
      chain.recordCalls.push(jobId);
      return sent();
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
    expiredAt: END + 86_400n,
    createdAt: END - 3_600n,
    fundedAt: END - 3_000n,
    submittedAt: END - 1_200n,
    challengeEnd: END,
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
    recordExpiries: false,
    ...overrides,
  });
  return { keeper, logs };
}

function wallClockAt(seconds: bigint): void {
  vi.spyOn(Date, "now").mockReturnValue(Number(seconds) * 1_000);
}

describe("the clock a tick decides by", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the chain's, so a window only the wall clock says is closed is left alone", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain = newChain({ blockTimestamp: END - 1n });
      const { keeper, logs } = build(db, chain);
      wallClockAt(END);

      const early = await keeper.tick();

      expect(early.finalized).toEqual([]);
      expect(early.skipped).toEqual([]);
      expect(chain.finalizeCalls).toEqual([]);
      expect(await keeperActions.recent(db, CHAIN, 10)).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.finalize_failed")).toEqual([]);

      chain.blockTimestamp = END;
      const onTime = await keeper.tick();

      expect(onTime.finalized).toEqual([1n]);
      expect(chain.finalizeCalls).toEqual([1n]);
      expect(chain.blocksRead).toBe(2);
      const journal = await keeperActions.recent(db, CHAIN, 10);
      expect(journal).toHaveLength(1);
      expect(journal[0]?.action).toBe("finalize");
      expect(journal[0]?.txHash).toBe(txHash);
    } finally {
      await db.close();
    }
  });

  it("is read once a tick and given to the mirror, the decision and the report", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n, challengeEnd: END - 600n }));
      const chain = newChain({ blockTimestamp: END, challengeEnd: END - 600n });
      const { keeper } = build(db, chain);
      wallClockAt(END + 86_400n);

      const report = await keeper.tick();

      expect(chain.blocksRead).toBe(1);
      expect(report.finalized).toEqual([1n]);
      expect(report.oldestPendingAgeSeconds).toBe(600);
    } finally {
      await db.close();
    }
  });

  it("is the chain's in the expiry sweep too, so a backoff window ends when the chain says it does", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n, status: jobs.JOB_STATUS.expired, challengeEnd: null, agentId: 892_531n }));
      await keeperJobState.bumpExpiryAttempts(db, CHAIN, 1n);
      await keeperJobState.scheduleExpiryRetry(db, CHAIN, 1n, END + 600n, false);
      const chain = newChain({ blockTimestamp: END });
      const { keeper } = build(db, chain, { recordExpiries: true });
      wallClockAt(END + 86_400n);

      expect((await keeper.sweepExpiries()).scanned).toBe(0);
      expect(chain.recordCalls).toEqual([]);

      chain.blockTimestamp = END + 600n;

      expect((await keeper.sweepExpiries()).recorded).toEqual([1n]);
      expect(chain.recordCalls).toEqual([1n]);
    } finally {
      await db.close();
    }
  });
});

describe("a revert that says the chain is not there yet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("costs a finalize no journal row, no error line and no backoff", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain = newChain({ blockTimestamp: END, revert: "execution reverted: WindowOpen(uint48 challengeEnd)" });
      const { keeper, logs } = build(db, chain);
      wallClockAt(END);

      const refused = await keeper.tick();

      expect(refused.finalized).toEqual([]);
      expect(refused.skipped).toEqual([{ jobId: 1n, reason: "windowOpen" }]);
      expect(await keeperActions.recent(db, CHAIN, 10)).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.finalize_failed")).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.not_yet")).toHaveLength(1);

      chain.blockTimestamp = END + 1n;
      const next = await keeper.tick();

      expect(next.finalized).toEqual([1n]);
      expect(next.skipped).toEqual([]);
      expect(chain.finalizeCalls).toEqual([1n]);
      expect((await keeperActions.recent(db, CHAIN, 10)).map((row) => row.action)).toEqual(["finalize"]);
    } finally {
      await db.close();
    }
  });

  it("costs a lapse the same nothing", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n, disputed: true, challengeEnd: null }));
      const chain = newChain({ blockTimestamp: END, disputed: true, revert: "execution reverted: NotLapsed()" });
      const { keeper, logs } = build(db, chain);
      wallClockAt(END);

      const refused = await keeper.tick();

      expect(refused.lapsed).toEqual([]);
      expect(refused.skipped).toEqual([{ jobId: 1n, reason: "notLapsed" }]);
      expect(await keeperActions.recent(db, CHAIN, 10)).toEqual([]);
      expect(logs.filter((entry) => entry.event === "keeper.finalize_failed")).toEqual([]);

      chain.blockTimestamp = END + 1n;
      const next = await keeper.tick();

      expect(next.lapsed).toEqual([1n]);
      expect(chain.lapseCalls).toEqual([1n]);
      expect((await keeperActions.recent(db, CHAIN, 10)).map((row) => row.action)).toEqual(["lapse"]);
    } finally {
      await db.close();
    }
  });

  it("is not confused with a revert that is a real failure", async () => {
    const db = await openDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));
      const chain = newChain({ blockTimestamp: END, revert: "execution reverted: NotOurJob()" });
      const { keeper, logs } = build(db, chain);
      wallClockAt(END);

      const failed = await keeper.tick();

      expect(failed.skipped).toEqual([]);
      expect((await keeperActions.recent(db, CHAIN, 10)).map((row) => row.action)).toEqual(["finalize"]);
      expect(logs.filter((entry) => entry.event === "keeper.finalize_failed")).toHaveLength(1);

      const backedOff = await keeper.tick();

      expect(backedOff.skipped).toEqual([{ jobId: 1n, reason: "backoff" }]);
    } finally {
      await db.close();
    }
  });
});
