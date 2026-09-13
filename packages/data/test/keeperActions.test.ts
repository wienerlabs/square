import { describe, it, expect } from "vitest";
import { keeperActions } from "../src/index.js";
import { openMigratedDatabase } from "./helpers.js";

const CHAIN = 31337;

describe("the give-up marker on a keeper action", () => {
  it("defaults to false and survives a read", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 1n, action: "finalize", reason: "execution reverted" });

      const [row] = await keeperActions.recent(db, CHAIN, 10);

      expect(row?.gaveUp).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("marks the journal row that recorded a give-up, and nothing reads it as state", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 7n, action: "finalize", reason: "gave up after 6 attempts", gaveUp: true });
      await keeperActions.append(db, { chainId: CHAIN, jobId: 7n, action: "finalize", reason: "execution reverted" });

      const rows = await keeperActions.recent(db, CHAIN, 10);

      expect(rows.map((row) => row.gaveUp)).toEqual([false, true]);
    } finally {
      await db.close();
    }
  });
});
