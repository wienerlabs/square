import { describe, it, expect } from "vitest";
import { jobs, keeperActions, keeperJobState } from "../src/index.js";
import { address, openMigratedDatabase } from "./helpers.js";

const CHAIN = 31337;
const NOW = 1_760_000_000n;
const evaluator = address(0xe1);

function expiredJob(jobId: bigint): jobs.JobRecord {
  return {
    chainId: CHAIN,
    jobId,
    client: address(0x11),
    provider: address(0x22),
    evaluator,
    hook: address(0x33),
    description: "translate a document",
    budget: 1_000n,
    status: jobs.JOB_STATUS.expired,
    expiredAt: NOW - 86_400n,
    createdAt: NOW - 90_000n,
    fundedAt: NOW - 89_000n,
    submittedAt: NOW - 88_000n,
    challengeEnd: null,
    platformFeeBp: 250,
    evaluatorFeeBp: 50,
    deliverable: null,
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: 892_531n,
    updatedBlock: 1_000n,
    refundReason: null,
  };
}

describe("the finalize give-up", () => {
  it("is written once per job, listed in job order, and cleared by the operator", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 7n);
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 7n);
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 2n);
      await keeperJobState.markFinalizeGaveUp(db, 5042002, 4n);

      expect(await keeperJobState.listFinalizeGaveUp(db, CHAIN)).toEqual([2n, 7n]);
      expect(await keeperJobState.listFinalizeGaveUp(db, 5042002)).toEqual([4n]);

      expect(await keeperJobState.clearFinalizeGiveUp(db, CHAIN, 7n)).toBe(1);
      expect(await keeperJobState.clearFinalizeGiveUp(db, CHAIN, 7n)).toBe(0);
      expect(await keeperJobState.listFinalizeGaveUp(db, CHAIN)).toEqual([2n]);
    } finally {
      await db.close();
    }
  });
});

describe("the unprofitable journal mark", () => {
  it("is claimed by the first caller only, so the row is written once whatever restarts", async () => {
    const db = await openMigratedDatabase();
    try {
      expect(await keeperJobState.markUnprofitableJournaled(db, CHAIN, 7n)).toBe(true);
      expect(await keeperJobState.markUnprofitableJournaled(db, CHAIN, 7n)).toBe(false);
      expect(await keeperJobState.markUnprofitableJournaled(db, CHAIN, 7n)).toBe(false);
      expect(await keeperJobState.markUnprofitableJournaled(db, 5042002, 7n)).toBe(true);

      expect((await keeperJobState.get(db, CHAIN, 7n))?.unprofitableJournaledAt).toBeInstanceOf(Date);
      expect((await keeperJobState.get(db, CHAIN, 8n))?.unprofitableJournaledAt).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("stands beside a give-up on the same job instead of overwriting it", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 3n);

      expect(await keeperJobState.markUnprofitableJournaled(db, CHAIN, 3n)).toBe(true);

      const state = await keeperJobState.get(db, CHAIN, 3n);
      expect(state?.finalizeGaveUp).toBe(true);
      expect(state?.unprofitableJournaledAt).toBeInstanceOf(Date);
    } finally {
      await db.close();
    }
  });

  it("survives the ninety day journal sweep that deletes the row it guards", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 5n, action: "skipped", reason: "unprofitable" });
      await keeperJobState.markUnprofitableJournaled(db, CHAIN, 5n);
      await db.query("update keeper_actions set created_at = now() - interval '91 days'");

      expect(await keeperActions.sweep(db)).toBe(1);

      expect(await keeperJobState.markUnprofitableJournaled(db, CHAIN, 5n)).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe("the expiry sweep's candidates", () => {
  it("leave the set through the recorded mark, not through a journal row", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const id of [1n, 2n, 3n]) await jobs.upsert(db, expiredJob(id));
      await keeperActions.append(db, { chainId: CHAIN, jobId: 1n, action: "recordExpiry" });

      expect((await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW)).map((row) => row.jobId)).toEqual([1n, 2n, 3n]);

      await keeperJobState.markExpiryRecorded(db, CHAIN, 1n);

      expect((await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW)).map((row) => row.jobId)).toEqual([2n, 3n]);
    } finally {
      await db.close();
    }
  });

  it("skip a job in backoff until its time, put the least recently due first, and drop a given-up job", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const id of [1n, 2n, 3n, 4n]) await jobs.upsert(db, expiredJob(id));
      expect(await keeperJobState.bumpExpiryAttempts(db, CHAIN, 1n)).toBe(1);
      expect(await keeperJobState.bumpExpiryAttempts(db, CHAIN, 1n)).toBe(2);
      await keeperJobState.scheduleExpiryRetry(db, CHAIN, 1n, NOW + 600n, false);
      await keeperJobState.bumpExpiryAttempts(db, CHAIN, 2n);
      await keeperJobState.scheduleExpiryRetry(db, CHAIN, 2n, NOW - 60n, false);
      await keeperJobState.bumpExpiryAttempts(db, CHAIN, 3n);
      await keeperJobState.scheduleExpiryRetry(db, CHAIN, 3n, NOW - 3_600n, true);

      const due = (await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW)).map((row) => row.jobId);

      expect(due).toEqual([4n, 2n]);
      expect((await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW + 601n)).map((row) => row.jobId)).toEqual([4n, 2n, 1n]);
      expect(await keeperJobState.listExpiryGaveUp(db, CHAIN)).toEqual([3n]);

      expect(await keeperJobState.clearExpiryGiveUp(db, CHAIN, 3n)).toBe(1);
      expect((await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW)).map((row) => row.jobId)).toEqual([3n, 4n, 2n]);
      expect((await keeperJobState.get(db, CHAIN, 3n))?.expiryAttempts).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("the ninety day journal sweep", () => {
  it("deletes journal rows and leaves both kinds of state where they were", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const id of [1n, 2n]) await jobs.upsert(db, expiredJob(id));
      await keeperActions.append(db, { chainId: CHAIN, jobId: 1n, action: "recordExpiry" });
      await keeperJobState.markExpiryRecorded(db, CHAIN, 1n);
      await keeperActions.append(db, { chainId: CHAIN, jobId: 9n, action: "finalize", reason: "gave up after 6 attempts", gaveUp: true });
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 9n);
      await db.query("update keeper_actions set created_at = now() - interval '91 days'");
      await db.query("update keeper_job_state set updated_at = now() - interval '91 days'");

      expect(await keeperActions.sweep(db)).toBe(2);

      expect(await keeperActions.recent(db, CHAIN, 10)).toEqual([]);
      expect((await jobs.listExpiredWithAgent(db, CHAIN, evaluator, 10, NOW)).map((row) => row.jobId)).toEqual([2n]);
      expect(await keeperJobState.listFinalizeGaveUp(db, CHAIN)).toEqual([9n]);
    } finally {
      await db.close();
    }
  });
});

describe("the hold", () => {
  it("keeps the clock of a standing hold, restarts it when the reason changes, and clears on release", async () => {
    const db = await openMigratedDatabase();
    try {
      expect(await keeperJobState.hold(db, CHAIN, 1n, "proofStale", NOW)).toBe(NOW);
      expect(await keeperJobState.hold(db, CHAIN, 1n, "proofStale", NOW + 600n)).toBe(NOW);
      expect(await keeperJobState.hold(db, CHAIN, 1n, "unscreened", NOW + 900n)).toBe(NOW + 900n);
      expect(await keeperJobState.hold(db, CHAIN, 2n, "proofStale", NOW + 30n)).toBe(NOW + 30n);

      expect(await keeperJobState.listHeld(db, CHAIN)).toEqual([
        { jobId: 1n, reason: "unscreened", since: NOW + 900n },
        { jobId: 2n, reason: "proofStale", since: NOW + 30n },
      ]);
      expect(await keeperJobState.countHeld(db, CHAIN)).toEqual({ proofStale: 1, unscreened: 1 });

      expect(await keeperJobState.releaseHold(db, CHAIN, 1n)).toBe(true);
      expect(await keeperJobState.releaseHold(db, CHAIN, 1n)).toBe(false);
      expect(await keeperJobState.countHeld(db, CHAIN)).toEqual({ proofStale: 1 });
      expect((await keeperJobState.get(db, CHAIN, 1n))?.heldReason).toBeNull();
      expect((await keeperJobState.get(db, CHAIN, 1n))?.heldSince).toBeNull();
      expect((await keeperJobState.get(db, CHAIN, 2n))?.heldSince).toBe(NOW + 30n);
    } finally {
      await db.close();
    }
  });

  it("holds a job the keeper already gave up on without touching the give-up or the expiry state", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperJobState.markFinalizeGaveUp(db, CHAIN, 7n);
      await keeperJobState.bumpExpiryAttempts(db, CHAIN, 7n);
      await keeperJobState.hold(db, CHAIN, 7n, "proofStale", NOW);

      const state = await keeperJobState.get(db, CHAIN, 7n);
      expect(state?.finalizeGaveUp).toBe(true);
      expect(state?.expiryAttempts).toBe(1);
      expect(state?.heldReason).toBe("proofStale");

      await keeperJobState.releaseHold(db, CHAIN, 7n);
      expect((await keeperJobState.get(db, CHAIN, 7n))?.finalizeGaveUp).toBe(true);
      expect((await keeperJobState.get(db, CHAIN, 7n))?.expiryAttempts).toBe(1);
    } finally {
      await db.close();
    }
  });
});
