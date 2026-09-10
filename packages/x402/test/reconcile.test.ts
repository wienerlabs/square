import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, x402Payments } from "@squaresdk/data";
import type { Hex, PublicClient } from "viem";
import {
  blockTimestampFromClient,
  RECONCILE_REASON,
  reconcileSettlements,
  type SettlementReceiptStatus,
} from "../src/reconcile.js";
import type { GatewayLogger } from "../src/logger.js";
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

interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown> | undefined;
}

function recordingLogger(lines: LogLine[]): GatewayLogger {
  return {
    info: (message, context) => void lines.push({ level: "info", message, context }),
    warn: (message, context) => void lines.push({ level: "warn", message, context }),
    error: (message, context) => void lines.push({ level: "error", message, context }),
  };
}

function clientAtBlockTime(timestamp: number): PublicClient {
  return { getBlock: async () => ({ timestamp: BigInt(timestamp) }) } as unknown as PublicClient;
}

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

  it("fails an expired authorization that was never broadcast, so nothing stays accepted forever", async () => {
    const store = memoryReplayStore();
    const expiredWithoutTx = entry(0xb2, BigInt(NOW - 1));
    const stillValid = entry(0xb3);
    for (const row of [expiredWithoutTx, stillValid]) await store.insertAccepted(row);

    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 2,
      settled: 0,
      failed: 1,
      unresolved: 1,
    });
    expect(store.get(expiredWithoutTx)?.status).toBe("failed");
    expect(store.get(expiredWithoutTx)?.reason).toBe(RECONCILE_REASON.expired);
    expect(store.get(expiredWithoutTx)?.txHash).toBeUndefined();
    expect(store.get(stillValid)?.status).toBe("accepted");
    expect(await store.has(expiredWithoutTx)).toBe(true);
  });

  it("does not mark an expired row failed when its receipt cannot be read, because it may already have settled", async () => {
    const store = memoryReplayStore();
    const expiredWithTx = entry(0xb1, BigInt(NOW - 1));
    await store.insertAccepted(expiredWithTx);
    await store.markPending(expiredWithTx, unseen);

    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 1,
      settled: 0,
      failed: 0,
      unresolved: 1,
    });
    const row = store.get(expiredWithTx);
    expect(row?.status).not.toBe("failed");
    expect(row?.status).toBe("accepted");
    expect(row?.reason).toBeUndefined();
    expect(row?.txHash).toBe(unseen);

    const caughtUp = async (txHash: Hex): Promise<SettlementReceiptStatus> => (txHash === unseen ? "success" : receiptStatusOf(txHash));
    expect(await reconcileSettlements({ store, receiptStatusOf: caughtUp, now: () => NOW })).toEqual({
      examined: 1,
      settled: 1,
      failed: 0,
      unresolved: 0,
    });
    expect(store.get(expiredWithTx)?.status).toBe("settled");
    expect(store.get(expiredWithTx)?.txHash).toBe(unseen);
  });

  it("never writes authorization_expired on a row that carries a transaction hash", async () => {
    const store = memoryReplayStore();
    const rows = [entry(0xf1, BigInt(NOW - 1)), entry(0xf2, BigInt(NOW - 1)), entry(0xf3, BigInt(NOW - 1)), entry(0xf4, BigInt(NOW - 1))];
    for (const row of rows) await store.insertAccepted(row);
    await store.markPending(rows[0]!, unseen);
    await store.markPending(rows[1]!, landed);
    await store.markPending(rows[2]!, reverted);

    expect(await reconcileSettlements({ store, receiptStatusOf, now: () => NOW })).toEqual({
      examined: 4,
      settled: 1,
      failed: 2,
      unresolved: 1,
    });
    for (const row of rows) {
      const record = store.get(row);
      if (record?.reason === RECONCILE_REASON.expired) {
        expect(record.txHash).toBeUndefined();
      }
    }
    expect(store.get(rows[0]!)?.status).toBe("accepted");
    expect(store.get(rows[1]!)?.status).toBe("settled");
    expect(store.get(rows[2]!)?.reason).toBe(RECONCILE_REASON.reverted);
    expect(store.get(rows[3]!)?.reason).toBe(RECONCILE_REASON.expired);
  });

  it("names why an unresolved row is unresolved instead of guessing a terminal reason", async () => {
    const store = memoryReplayStore();
    const unreadable = entry(0xe1, BigInt(NOW - 1));
    const waiting = entry(0xe2);
    for (const row of [unreadable, waiting]) await store.insertAccepted(row);
    await store.markPending(unreadable, unseen);
    const lines: LogLine[] = [];

    await reconcileSettlements({ store, receiptStatusOf, now: () => NOW, logger: recordingLogger(lines) });

    const unresolved = lines.filter((line) => line.message === "x402 settlement still unresolved");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]?.context).toMatchObject({ reason: RECONCILE_REASON.receiptUnreadable, transaction: unseen });
    expect(unresolved[1]?.context).toMatchObject({ reason: RECONCILE_REASON.awaitingSettlement, transaction: null });
    expect(lines.some((line) => line.message === "x402 settlement reconciled as failed")).toBe(false);
  });

  it("takes now from the chain when given a block clock, not from the local wall clock", async () => {
    const store = memoryReplayStore();
    const expired = entry(0xd7, BigInt(NOW - 1));
    const notYet = entry(0xd8, BigInt(NOW + 1));
    for (const row of [expired, notYet]) await store.insertAccepted(row);

    expect(
      await reconcileSettlements({ store, receiptStatusOf, now: blockTimestampFromClient(clientAtBlockTime(NOW)) }),
    ).toEqual({ examined: 2, settled: 0, failed: 1, unresolved: 1 });
    expect(store.get(expired)?.reason).toBe(RECONCILE_REASON.expired);
    expect(store.get(notYet)?.status).toBe("accepted");
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
