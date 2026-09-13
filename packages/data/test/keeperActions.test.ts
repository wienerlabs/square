import { describe, it, expect } from "vitest";
import { keeperActions } from "../src/index.js";
import { openMigratedDatabase } from "./helpers.js";

const CHAIN = 31337;

describe("the give-up flag on a keeper action", () => {
  it("defaults to false and survives a read", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 1n, action: "finalize", reason: "execution reverted" });

      const [row] = await keeperActions.recent(db, CHAIN, 10);

      expect(row?.gaveUp).toBe(false);
      expect(await keeperActions.listGaveUp(db, CHAIN)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("names the jobs the keeper gave up on, once each and in job order", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 7n, action: "finalize", reason: "gave up after 6 attempts", gaveUp: true });
      await keeperActions.append(db, { chainId: CHAIN, jobId: 7n, action: "finalize", reason: "gave up again", gaveUp: true });
      await keeperActions.append(db, { chainId: CHAIN, jobId: 2n, action: "lapse", reason: "gave up after 6 attempts", gaveUp: true });
      await keeperActions.append(db, { chainId: CHAIN, jobId: 3n, action: "finalize", reason: "execution reverted" });
      await keeperActions.append(db, { chainId: 5042002, jobId: 4n, action: "finalize", reason: "gave up", gaveUp: true });

      expect(await keeperActions.listGaveUp(db, CHAIN)).toEqual([2n, 7n]);
      expect(await keeperActions.listGaveUp(db, 5042002)).toEqual([4n]);
    } finally {
      await db.close();
    }
  });

  it("lets an operator clear one job so the keeper may try it again", async () => {
    const db = await openMigratedDatabase();
    try {
      await keeperActions.append(db, { chainId: CHAIN, jobId: 7n, action: "finalize", reason: "gave up", gaveUp: true });
      await keeperActions.append(db, { chainId: CHAIN, jobId: 8n, action: "finalize", reason: "gave up", gaveUp: true });

      const cleared = await keeperActions.clearGiveUp(db, CHAIN, 7n);

      expect(cleared).toBe(1);
      expect(await keeperActions.listGaveUp(db, CHAIN)).toEqual([8n]);
      expect(await keeperActions.clearGiveUp(db, CHAIN, 7n)).toBe(0);
    } finally {
      await db.close();
    }
  });
});
