import { describe, it, expect } from "vitest";
import { disputes } from "../src/index.js";
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
