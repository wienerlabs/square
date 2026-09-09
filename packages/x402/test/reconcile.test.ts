import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, x402Payments } from "@squaresdk/data";
import type { Hex } from "viem";
import { RECONCILE_REASON, reconcileSettlements, type SettlementReceiptStatus } from "../src/reconcile.js";
import { REPLAY_STATUS_CODE, memoryReplayStore, postgresReplayStore, type ReplayEntry } from "../src/replay-store.js";

const NOW = 1_800_000_000;

function entry(nonce: number, validBefore = BigInt(NOW + 300)): ReplayEntry {
  return {
    chainId: 5042002,
    asset: "0x3600000000000000000000000000000000000000",
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    nonce: `0x${nonce.toString(16).padStart(2, "0").repeat(32)}`,
    amount: 50_000n,
    payTo: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    resource: "http://gateway.local/quote",
    validBefore,
  };
}

const landed = ("0x" + "11".repeat(32)) as Hex;
const reverted = ("0x" + "22".repeat(32)) as Hex;
const unseen = ("0x" + "33".repeat(32)) as Hex;

const receipts: Record<string, SettlementReceiptStatus> = {
  [landed]: "success",
  [reverted]: "reverted",
  [unseen]: "unknown",
};

const receiptStatusOf = async (txHash: Hex): Promise<SettlementReceiptStatus> => receipts[txHash] ?? "unknown";

describe("reconcileSettlements", () => {
  it("moves a pending settlement to settled or failed and leaves an undecided one alone", async () => {
    const store = memoryReplayStore();
    const settles = entry(0xa1);
    const reverts = entry(0xa2);
    const inFlight = entry(0xa3);
    for (const row of [settles, reverts, inFlight]) await store.insertAccepted(row);
    await store.markPending(settles, landed);
    await store.markPending(reverts, reverted);
    await store.markPending(inFlight, unseen);

    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 3,
      settled: 1,
      failed: 1,
      unresolved: 1,
    });
    expect(store.get(settles)?.status).toBe("settled");
    expect(store.get(settles)?.txHash).toBe(landed);
    expect(store.get(reverts)?.status).toBe("failed");
    expect(store.get(reverts)?.reason).toBe(RECONCILE_REASON.reverted);
    expect(store.get(inFlight)?.status).toBe("accepted");
  });

  it("fails a row the chain can no longer accept, so nothing stays accepted forever", async () => {
    const store = memoryReplayStore();
    const expiredWithTx = entry(0xb1, BigInt(NOW - 1));
    const expiredWithoutTx = entry(0xb2, BigInt(NOW - 1));
    const stillValid = entry(0xb3);
    for (const row of [expiredWithTx, expiredWithoutTx, stillValid]) await store.insertAccepted(row);
    await store.markPending(expiredWithTx, unseen);

    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 3,
      settled: 0,
      failed: 2,
      unresolved: 1,
    });
    expect(store.get(expiredWithTx)?.reason).toBe(RECONCILE_REASON.expired);
    expect(store.get(expiredWithoutTx)?.reason).toBe(RECONCILE_REASON.expired);
    expect(store.get(stillValid)?.status).toBe("accepted");
    expect(await store.has(expiredWithTx)).toBe(true);
  });

  it("is idempotent: a second pass over a reconciled ledger has nothing to do", async () => {
    const store = memoryReplayStore();
    const settles = entry(0xc1);
    await store.insertAccepted(settles);
    await store.markPending(settles, landed);
    await reconcileSettlements({ store, receiptStatusOf, now: () => NOW });
    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 0,
      settled: 0,
      failed: 0,
      unresolved: 0,
    });
  });

  it("closes a stuck row in the durable ledger", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up");
      const store = postgresReplayStore(db);
      const stuck = entry(0xd1);
      await store.insertAccepted(stuck);
      await store.markPending(stuck, landed);
      expect((await x402Payments.get(db, stuck))?.status).toBe(REPLAY_STATUS_CODE.accepted);

      expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
        examined: 1,
        settled: 1,
        failed: 0,
        unresolved: 0,
      });
      const row = await x402Payments.get(db, stuck);
      expect(row?.status).toBe(REPLAY_STATUS_CODE.settled);
      expect(row?.txHash).toBe(landed);
      expect(await store.has(stuck)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
