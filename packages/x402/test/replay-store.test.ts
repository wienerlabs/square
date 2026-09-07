import { describe, expect, it } from "vitest";
import {
  REPLAY_STATUS_CODE,
  X402_PAYMENTS_DDL,
  memoryReplayStore,
  postgresReplayStore,
  replayKeyString,
  type ReplayEntry,
  type SqlDatabase,
} from "../src/replay-store.js";

const entry: ReplayEntry = {
  chainId: 5042002,
  asset: "0x3600000000000000000000000000000000000000",
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  nonce: "0x" + "ab".repeat(32) as `0x${string}`,
  amount: 50_000n,
  payTo: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  resource: "http://gateway.local/quote",
  validBefore: 1_800_000_000n,
};

const txHash = ("0x" + "cd".repeat(32)) as `0x${string}`;

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
    await store.markSettled(entry, txHash);
    expect(store.get(entry)?.status).toBe("settled");
    expect(store.get(entry)?.txHash).toBe(txHash);
    await store.markFailed(entry, "late failure");
    expect(store.get(entry)?.status).toBe("settled");
  });

  it("marks an accepted record failed", async () => {
    const store = memoryReplayStore();
    await store.insertAccepted(entry);
    await store.markFailed(entry, "reverted");
    expect(store.get(entry)?.status).toBe("failed");
    expect(store.get(entry)?.reason).toBe("reverted");
    expect(await store.has(entry)).toBe(true);
  });
});

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function fakeDb(responses: Array<{ rows: unknown[]; rowCount: number | null }>): {
  db: SqlDatabase;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const db: SqlDatabase = {
    async query(text, params) {
      queries.push({ text, params });
      const next = responses.shift();
      if (!next) {
        throw new Error("fake db: no scripted response left");
      }
      return next;
    },
  };
  return { db, queries };
}

describe("postgresReplayStore", () => {
  it("returns true for the first insert and false when the row already exists", async () => {
    const { db, queries } = fakeDb([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const store = postgresReplayStore(db);
    expect(await store.insertAccepted(entry)).toBe(true);
    expect(await store.insertAccepted(entry)).toBe(false);
    expect(queries).toHaveLength(2);
    const sql = queries[0]?.text.replace(/\s+/g, " ") ?? "";
    expect(sql).toContain("insert into x402_payments");
    expect(sql).toContain("on conflict do nothing");
    const params = queries[0]?.params ?? [];
    expect(params[0]).toBe(entry.chainId);
    expect(Buffer.isBuffer(params[1])).toBe(true);
    expect((params[1] as Buffer).toString("hex")).toBe(entry.asset.slice(2).toLowerCase());
    expect((params[2] as Buffer).toString("hex")).toBe(entry.payer.slice(2).toLowerCase());
    expect((params[3] as Buffer).toString("hex")).toBe(entry.nonce.slice(2));
    expect(params[4]).toBe("50000");
    expect((params[5] as Buffer).toString("hex")).toBe(entry.payTo.slice(2).toLowerCase());
    expect(params[6]).toBe(entry.resource);
    expect(params[7]).toBe(REPLAY_STATUS_CODE.accepted);
    expect(params[8]).toBe("1800000000");
  });

  it("updates status on settle and failure without touching other keys", async () => {
    const { db, queries } = fakeDb([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const store = postgresReplayStore(db);
    await store.markSettled(entry, txHash);
    await store.markFailed(entry, "reverted");
    const settle = queries[0]?.text.replace(/\s+/g, " ") ?? "";
    expect(settle).toContain("update x402_payments set status = $5, tx_hash = $6");
    expect(settle).toContain("chain_id = $1 and asset = $2 and payer = $3 and nonce = $4");
    expect(queries[0]?.params[4]).toBe(REPLAY_STATUS_CODE.settled);
    expect((queries[0]?.params[5] as Buffer).toString("hex")).toBe(txHash.slice(2));
    const fail = queries[1]?.text.replace(/\s+/g, " ") ?? "";
    expect(fail).toContain("set status = $5");
    expect(fail).toContain(`status <> ${REPLAY_STATUS_CODE.settled}`);
    expect(queries[1]?.params[4]).toBe(REPLAY_STATUS_CODE.failed);
  });

  it("answers has() from the selected rows", async () => {
    const { db } = fakeDb([
      { rows: [{ "?column?": 1 }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const store = postgresReplayStore(db);
    expect(await store.has(entry)).toBe(true);
    expect(await store.has(entry)).toBe(false);
  });

  it("ships the table definition the store expects", () => {
    expect(X402_PAYMENTS_DDL).toContain("primary key (chain_id, asset, payer, nonce)");
    expect(X402_PAYMENTS_DDL).toContain("status smallint not null");
  });
});
