import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, x402Payments, type Database } from "@squaresdk/data";
import {
  REPLAY_STATUS_CODE,
  memoryReplayStore,
  postgresReplayStore,
  replayKeyString,
  type ReplayEntry,
  type ReplayStore,
} from "../src/replay-store.js";

const entry: ReplayEntry = {
  chainId: 5042002,
  asset: "0x3600000000000000000000000000000000000000",
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
  amount: 50_000n,
  payTo: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  resource: "http://gateway.local/quote",
  validBefore: 1_800_000_000n,
};

const txHash = ("0x" + "cd".repeat(32)) as `0x${string}`;
const otherTxHash = ("0x" + "ef".repeat(32)) as `0x${string}`;

async function openLedger(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

describe("memoryReplayStore", () => {
  it("accepts once, then reports the key as seen", async () => {
    const store = memoryReplayStore();
    expect(await store.has(entry)).toBe(false);
    expect(await store.insertAccepted(entry)).toBe(true);
    expect(await store.insertAccepted(entry)).toBe(false);
    expect(await store.has(entry)).toBe(true);
    expect(store.get(entry)?.status).toBe("accepted");
    expect(store.size()).toBe(1);
  });

  it("is case-insensitive on the key", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    const upper = {
      ...entry,
      asset: entry.asset.toUpperCase().replace("0X", "0x") as `0x${string}`,
      payer: entry.payer.toLowerCase() as `0x${string}`,
    };
    expect(await store.has(upper)).toBe(true);
    expect(replayKeyString(upper)).toBe(replayKeyString(entry));
  });

  it("records settlement and never downgrades a settled record", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    expect(await store.markSettled(entry, txHash)).toBe(true);
    expect(store.get(entry)?.status).toBe("settled");
    expect(store.get(entry)?.txHash).toBe(txHash);
    expect(await store.markFailed(entry, "late failure")).toBe(false);
    expect(store.get(entry)?.status).toBe("settled");
    expect(await store.markSettled(entry, otherTxHash)).toBe(false);
    expect(store.get(entry)?.txHash).toBe(txHash);
  });

  it("marks an accepted record failed and keeps failed terminal", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    expect(await store.markFailed(entry, "reverted")).toBe(true);
    expect(store.get(entry)?.status).toBe("failed");
    expect(store.get(entry)?.reason).toBe("reverted");
    expect(await store.has(entry)).toBe(true);
    expect(await store.markSettled(entry, txHash)).toBe(false);
    expect(store.get(entry)?.status).toBe("failed");
  });

  it("keeps the transaction hash a failure was handed", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    expect(await store.markFailed(entry, "invalid_exact_evm_transaction_failed", txHash)).toBe(true);
    expect(store.get(entry)?.status).toBe("failed");
    expect(store.get(entry)?.txHash).toBe(txHash);
  });

  it("leaves the hash the row already carried when a failure brings none", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    await store.markPending(entry, txHash);
    expect(await store.markFailed(entry, "settle_failed")).toBe(true);
    expect(store.get(entry)?.txHash).toBe(txHash);
  });

  it("reports a transition that found no accepted row", async () => {
    const store = memoryReplayStore();
    expect(await store.markSettled(entry, txHash)).toBe(false);
    expect(await store.markFailed(entry, "never accepted")).toBe(false);
    expect(await store.markPending(entry, txHash)).toBe(false);
  });

  it("keeps a pending row accepted and lists it for reconciliation", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    expect(await store.markPending(entry, txHash)).toBe(true);
    expect(store.get(entry)?.status).toBe("accepted");
    expect(await store.listUnsettled()).toEqual([
      {
        chainId: entry.chainId,
        asset: entry.asset,
        payer: entry.payer,
        nonce: entry.nonce,
        txHash,
        validBefore: entry.validBefore,
      },
    ]);
    await store.markSettled(entry, txHash);
    expect(await store.listUnsettled()).toEqual([]);
  });
});

describe("postgresReplayStore", () => {
  async function withStore(run: (store: ReplayStore, db: Database) => Promise<void>): Promise<void> {
    const db = await openLedger();
    try {
      await run(postgresReplayStore(db), db);
    } finally {
      await db.close();
    }
  }

  it("writes one row per authorization identity and refuses the replay", async () => {
    await withStore(async (store, db) => {
      expect(await store.has(entry)).toBe(false);
      expect(await store.insertAccepted(entry)).toBe(true);
      expect(await store.insertAccepted(entry)).toBe(false);
      expect(await store.has(entry)).toBe(true);
      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(REPLAY_STATUS_CODE.accepted);
      expect(row?.amount).toBe(entry.amount);
      expect(row?.payTo.toLowerCase()).toBe(entry.payTo.toLowerCase());
      expect(row?.resource).toBe(entry.resource);
      expect(row?.txHash).toBeNull();
    });
  });

  it("follows one transition rule: only an accepted row moves, and the caller is told", async () => {
    await withStore(async (store, db) => {
      await store.insertAccepted(entry);
      expect(await store.markSettled(entry, txHash)).toBe(true);
      expect(await store.markSettled(entry, otherTxHash)).toBe(false);
      expect(await store.markFailed(entry, "late failure")).toBe(false);
      const settled = await x402Payments.get(db, entry);
      expect(settled?.status).toBe(REPLAY_STATUS_CODE.settled);
      expect(settled?.txHash).toBe(txHash);
      expect(settled?.reason).toBeNull();

      const failing = { ...entry, nonce: ("0x" + "11".repeat(32)) as `0x${string}` };
      await store.insertAccepted(failing);
      expect(await store.markFailed(failing, "insufficient_funds")).toBe(true);
      expect(await store.markSettled(failing, txHash)).toBe(false);
      const failed = await x402Payments.get(db, failing);
      expect(failed?.status).toBe(REPLAY_STATUS_CODE.failed);
      expect(failed?.reason).toBe("insufficient_funds");
    });
  });

  it("stores the failure reason the interface asks for", async () => {
    await withStore(async (store, db) => {
      await store.insertAccepted(entry);
      await store.markFailed(entry, "settle_failed");
      expect((await x402Payments.get(db, entry))?.reason).toBe("settle_failed");
    });
  });

  it("writes the transaction hash of a settlement that reverted on chain", async () => {
    await withStore(async (store, db) => {
      await store.insertAccepted(entry);
      expect(await store.markFailed(entry, "invalid_exact_evm_transaction_failed", txHash)).toBe(true);
      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(REPLAY_STATUS_CODE.failed);
      expect(row?.reason).toBe("invalid_exact_evm_transaction_failed");
      expect(row?.txHash).toBe(txHash);
    });
  });

  it("leaves tx_hash alone when a failure carries no hash", async () => {
    await withStore(async (store, db) => {
      await store.insertAccepted(entry);
      await store.markPending(entry, txHash);
      expect(await store.markFailed(entry, "settle_failed")).toBe(true);
      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(REPLAY_STATUS_CODE.failed);
      expect(row?.txHash).toBe(txHash);
    });
  });

  it("keeps a pending settlement accepted, with its transaction hash, and lists it", async () => {
    await withStore(async (store, db) => {
      await store.insertAccepted(entry);
      expect(await store.markPending(entry, txHash)).toBe(true);
      expect((await x402Payments.get(db, entry))?.status).toBe(REPLAY_STATUS_CODE.accepted);
      expect((await x402Payments.get(db, entry))?.txHash).toBe(txHash);
      const unsettled = await store.listUnsettled();
      expect(unsettled).toHaveLength(1);
      expect(unsettled[0]?.txHash).toBe(txHash);
      expect(unsettled[0]?.validBefore).toBe(entry.validBefore);
      expect(unsettled[0]?.payer.toLowerCase()).toBe(entry.payer.toLowerCase());
      await store.markSettled(entry, txHash);
      expect(await store.listUnsettled()).toEqual([]);
    });
  });

  it("refuses an authorization the migration's amount column cannot hold", async () => {
    await withStore(async (store) => {
      const huge = { ...entry, amount: 2n ** 256n - 1n };
      await expect(store.insertAccepted(huge)).rejects.toThrow(/numeric field overflow/i);
    });
  });
});
