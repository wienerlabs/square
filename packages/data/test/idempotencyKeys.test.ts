import { describe, it, expect } from "vitest";
import * as idempotencyKeys from "../src/repositories/idempotencyKeys.js";
import { hash32, openMigratedDatabase } from "./helpers.js";

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
        expiresAt: new Date(Date.now() + 60_000),
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
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      };
      expect(await idempotencyKeys.putIfAbsent(db, expired)).toEqual({ outcome: "stored" });
      expect(await idempotencyKeys.get(db, "x402", "old")).toBeNull();
      expect(await idempotencyKeys.sweepExpired(db)).toBe(1);

      expect(await idempotencyKeys.putIfAbsent(db, expired)).toEqual({ outcome: "stored" });
      const renewed = await idempotencyKeys.putIfAbsent(db, {
        ...expired,
        requestHash: hash32(0x09),
        response: "second",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(renewed).toEqual({ outcome: "stored" });
      expect((await idempotencyKeys.get(db, "x402", "old"))?.response).toBe("second");
      expect(await idempotencyKeys.sweepExpired(db)).toBe(0);
    } finally {
      await db.close();
    }
  });
});
