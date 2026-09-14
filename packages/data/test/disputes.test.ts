import { describe, it, expect } from "vitest";
import { disputes, jobs } from "../src/index.js";
import { address, openMigratedDatabase } from "./helpers.js";

const CHAIN = 31337;

function dispute(jobId: bigint, closed: boolean): disputes.DisputeRecord {
  return {
    chainId: CHAIN,
    jobId,
    disputer: address(9),
    bond: 5_000_000n,
    disputedAt: 1_760_000_000n,
    resolveBy: 1_760_100_000n,
    setVersion: 1,
    outcome: closed ? disputes.DISPUTE_OUTCOME.complete : null,
    providerBps: closed ? 10_000 : null,
    closed,
    updatedBlock: 1_000n,
  };
}

describe("counting open disputes", () => {
  it("answers with a count without reading the rows, and agrees with the list", async () => {
    const db = await openMigratedDatabase();
    try {
      await disputes.upsert(db, dispute(1n, false));
      await disputes.upsert(db, dispute(2n, false));
      await disputes.upsert(db, dispute(3n, true));

      const counted = await disputes.countOpen(db, CHAIN);
      const listed = await disputes.listOpen(db, CHAIN);

      expect(counted).toBe(2);
      expect(listed).toHaveLength(2);
      expect(listed.map((row) => row.jobId)).toEqual([1n, 2n]);
    } finally {
      await db.close();
    }
  });

  it("counts zero on a chain with no disputes at all", async () => {
    const db = await openMigratedDatabase();
    try {
      await disputes.upsert(db, dispute(1n, false));

      expect(await disputes.countOpen(db, 5042002)).toBe(0);
      expect(await disputes.countOpen(db, CHAIN)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("stops counting a dispute once it closes", async () => {
    const db = await openMigratedDatabase();
    try {
      await disputes.upsert(db, dispute(1n, false));
      expect(await disputes.countOpen(db, CHAIN)).toBe(1);

      await disputes.upsert(db, dispute(1n, true));

      expect(await disputes.countOpen(db, CHAIN)).toBe(0);
      expect(await disputes.listOpen(db, CHAIN)).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

describe("expired jobs whose dispute is still open", () => {
  function expired(jobId: bigint, evaluator = address(0xe1)): jobs.JobRecord {
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
      expiredAt: 1_760_000_000n,
      createdAt: 1_759_900_000n,
      fundedAt: 1_759_910_000n,
      submittedAt: 1_759_920_000n,
      challengeEnd: null,
      platformFeeBp: 250,
      evaluatorFeeBp: 50,
      deliverable: null,
      payee: null,
      providerBps: null,
      reason: null,
      disputed: true,
      agentId: null,
      updatedBlock: 1_000n,
      refundReason: "payoutUnresolvable",
    };
  }

  it("are listed until the bond settlement closes the dispute, and only under the given evaluator", async () => {
    const db = await openMigratedDatabase();
    try {
      await jobs.upsert(db, expired(1n));
      await jobs.upsert(db, expired(2n));
      await jobs.upsert(db, expired(3n, address(0x99)));
      await jobs.upsert(db, { ...expired(4n), status: jobs.JOB_STATUS.submitted });
      await disputes.upsert(db, dispute(1n, false));
      await disputes.upsert(db, dispute(2n, true));
      await disputes.upsert(db, dispute(3n, false));
      await disputes.upsert(db, dispute(4n, false));

      expect((await jobs.listExpiredDisputed(db, CHAIN)).map((row) => row.jobId)).toEqual([1n, 3n]);
      expect((await jobs.listExpiredDisputed(db, CHAIN, address(0xe1))).map((row) => row.jobId)).toEqual([1n]);

      await disputes.upsert(db, dispute(1n, true));

      expect(await jobs.listExpiredDisputed(db, CHAIN, address(0xe1))).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
