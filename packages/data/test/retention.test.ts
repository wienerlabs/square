import { describe, it, expect } from "vitest";
import * as idempotencyKeys from "../src/repositories/idempotencyKeys.js";
import * as keeperActions from "../src/repositories/keeperActions.js";
import * as rateLimits from "../src/repositories/rateLimits.js";
import * as x402Payments from "../src/repositories/x402Payments.js";
import { DEFAULT_RATE_LIMIT_WINDOW_MS, sweepAll } from "../src/retention.js";
import { address, hash32, openMigratedDatabase } from "./helpers.js";
import type { Database } from "../src/database.js";

async function seedKeeperActions(db: Database): Promise<void> {
  const stale = await keeperActions.append(db, { chainId: 5042002, jobId: 1n, action: "skipped", reason: "unprofitable" });
  await keeperActions.append(db, { chainId: 5042002, jobId: 2n, action: "finalize", txHash: hash32(0x11) });
  await db.query("update keeper_actions set created_at = now() - interval '91 days' where id = $1", [stale.toString()]);
}

describe("keeperActions.sweep", () => {
  it("keeps ninety days of journal and drops what is older", async () => {
    const db = await openMigratedDatabase();
    try {
      await seedKeeperActions(db);
      expect(await keeperActions.sweep(db)).toBe(1);
      const left = await keeperActions.recent(db, 5042002);
      expect(left).toHaveLength(1);
      expect(left[0]?.action).toBe("finalize");
      expect(await keeperActions.sweep(db)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("sweepAll", () => {
  it("runs every retention sweep once and reports what each removed", async () => {
    const db = await openMigratedDatabase();
    try {
      await seedKeeperActions(db);

      await idempotencyKeys.putIfAbsent(db, {
        scope: "orders",
        key: "expired",
        requestHash: hash32(0x01),
        status: 201,
        response: { id: 1 },
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      await idempotencyKeys.putIfAbsent(db, {
        scope: "orders",
        key: "live",
        requestHash: hash32(0x02),
        status: 201,
        response: { id: 2 },
        expiresAt: new Date(Date.now() + 60_000),
      });

      await rateLimits.increment(db, "ip:1.1.1.1", new Date(Date.now() - 10 * DEFAULT_RATE_LIMIT_WINDOW_MS));
      await rateLimits.increment(db, "ip:2.2.2.2", new Date());

      const stale: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x42),
        amount: 1n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_000_000_000n,
      };
      await x402Payments.insertAccepted(db, stale);
      await x402Payments.insertAccepted(db, { ...stale, nonce: hash32(0x43), validBefore: 4_000_000_000n });

      expect(await sweepAll(db)).toEqual({
        idempotency_keys: 1,
        rate_limits: 1,
        x402_payments: 1,
        keeper_actions: 1,
      });

      expect(await idempotencyKeys.get(db, "orders", "live")).not.toBeNull();
      expect(await x402Payments.get(db, { ...stale, nonce: hash32(0x43) })).not.toBeNull();
      expect(await keeperActions.recent(db, 5042002)).toHaveLength(1);

      expect(await sweepAll(db)).toEqual({
        idempotency_keys: 0,
        rate_limits: 0,
        x402_payments: 0,
        keeper_actions: 0,
      });
    } finally {
      await db.close();
    }
  });
});
