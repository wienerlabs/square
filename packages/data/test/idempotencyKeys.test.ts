import { describe, it, expect } from "vitest";
import * as idempotencyKeys from "../src/repositories/idempotencyKeys.js";
import type { Database, QueryResult } from "../src/database.js";
import { databaseWithClockAhead, hash32, openMigratedDatabase } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function remainingLifetimeMs(db: Database, scope: string, key: string): Promise<number> {
  const { rows } = await db.query<{ remaining_ms: string }>(
    "select extract(epoch from (expires_at - now())) * 1000 as remaining_ms from idempotency_keys where scope = $1 and key = $2",
    [scope, key],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no idempotency row for ${scope}/${key}`);
  return Number(row.remaining_ms);
}

describe("idempotencyKeys.putIfAbsent", () => {
  it("stores once, replays on the same request hash, conflicts on a different one", async () => {
    const db = await openMigratedDatabase();
    try {
      const input: idempotencyKeys.IdempotencyInput = {
        scope: "x402",
        key: "client-key-1",
        requestHash: hash32(0x01),
        status: 200,
        response: { ok: true, txHash: hash32(0x02) },
        ttlMs: 60_000,
      };
      expect(await idempotencyKeys.putIfAbsent(db, input)).toEqual({ outcome: "stored" });

      const replay = await idempotencyKeys.putIfAbsent(db, { ...input, status: 500, response: { ok: false } });
      expect(replay.outcome).toBe("replay");
      if (replay.outcome !== "replay") throw new Error("unreachable");
      expect(replay.record.status).toBe(200);
      expect(replay.record.response).toEqual(input.response);
      expect(replay.record.requestHash).toBe(hash32(0x01));

      const conflict = await idempotencyKeys.putIfAbsent(db, { ...input, requestHash: hash32(0x03) });
      expect(conflict.outcome).toBe("conflict");
      if (conflict.outcome !== "conflict") throw new Error("unreachable");
      expect(conflict.record.response).toEqual(input.response);

      const stored = await idempotencyKeys.get(db, "x402", "client-key-1");
      expect(stored?.response).toEqual(input.response);
      expect(await idempotencyKeys.get(db, "agent-api", "client-key-1")).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("treats an expired key as absent and sweeps it after the retention window", async () => {
    const db = await openMigratedDatabase();
    try {
      const expired: idempotencyKeys.IdempotencyInput = {
        scope: "x402",
        key: "old",
        requestHash: hash32(0x01),
        status: 200,
        response: "first",
        ttlMs: -25 * 60 * 60 * 1000,
      };
      expect(await idempotencyKeys.putIfAbsent(db, expired)).toEqual({ outcome: "stored" });
      expect(await idempotencyKeys.get(db, "x402", "old")).toBeNull();
      expect(await idempotencyKeys.sweepExpired(db)).toBe(1);

      expect(await idempotencyKeys.putIfAbsent(db, expired)).toEqual({ outcome: "stored" });
      const renewed = await idempotencyKeys.putIfAbsent(db, {
        ...expired,
        requestHash: hash32(0x09),
        response: "second",
        ttlMs: 60_000,
      });
      expect(renewed).toEqual({ outcome: "stored" });
      expect((await idempotencyKeys.get(db, "x402", "old"))?.response).toBe("second");
      expect(await idempotencyKeys.sweepExpired(db)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it.each([
    ["equal to the database", 0],
    ["25 hours behind the database", 25 * 60 * 60 * 1000],
    ["1 hour behind the database", 60 * 60 * 1000],
  ] as const)("keeps the whole ttl when the application clock is %s", async (_label, databaseAheadMs) => {
    const base = await openMigratedDatabase();
    try {
      const db = databaseWithClockAhead(base, databaseAheadMs);
      const input: idempotencyKeys.IdempotencyInput = {
        scope: "orders",
        key: "k1",
        requestHash: hash32(0x01),
        status: 201,
        response: { id: 1 },
        ttlMs: DAY_MS,
      };
      expect(await idempotencyKeys.putIfAbsent(db, input)).toEqual({ outcome: "stored" });
      expect(await idempotencyKeys.get(db, "orders", "k1")).not.toBeNull();
      expect(await idempotencyKeys.putIfAbsent(db, { ...input, response: { id: 2 } })).toMatchObject({ outcome: "replay" });
      expect(Math.abs((await remainingLifetimeMs(db, "orders", "k1")) - DAY_MS)).toBeLessThan(5_000);
    } finally {
      await base.close();
    }
  });

  it("gives up after a bounded number of claims when the row keeps vanishing", async () => {
    let claims = 0;
    const db: Database = {
      async query<T>(text: string): Promise<QueryResult<T>> {
        if (text.startsWith("insert")) claims += 1;
        return { rows: [], rowCount: 0 };
      },
      transaction<T>(): Promise<T> {
        return Promise.reject(new Error("no transaction is expected here"));
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    await expect(
      idempotencyKeys.putIfAbsent(db, {
        scope: "orders",
        key: "k1",
        requestHash: hash32(0x01),
        status: 201,
        response: { id: 1 },
        ttlMs: DAY_MS,
      }),
    ).rejects.toThrow(/expired between the claim and the read/);
    expect(claims).toBe(idempotencyKeys.CLAIM_ATTEMPTS);
  });
});
