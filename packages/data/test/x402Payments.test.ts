import { describe, it, expect } from "vitest";
import * as x402Payments from "../src/repositories/x402Payments.js";
import { address, hash32, openMigratedDatabase } from "./helpers.js";

describe("x402Payments", () => {
  it("accepts an authorization once and refuses the replay", async () => {
    const db = await openMigratedDatabase();
    try {
      const payment: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x42),
        amount: 1_000_000n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      expect(await x402Payments.insertAccepted(db, payment)).toBe(true);
      expect(await x402Payments.insertAccepted(db, payment)).toBe(false);
      expect(await x402Payments.insertAccepted(db, { ...payment, amount: 5n })).toBe(false);
      expect(await x402Payments.insertAccepted(db, { ...payment, nonce: hash32(0x43) })).toBe(true);
      expect(await x402Payments.insertAccepted(db, { ...payment, chainId: 1 })).toBe(true);

      const accepted = await x402Payments.get(db, payment);
      expect(accepted?.status).toBe(x402Payments.X402_STATUS.accepted);
      expect(accepted?.amount).toBe(1_000_000n);
      expect(accepted?.txHash).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("moves accepted to settled or failed exactly once", async () => {
    const db = await openMigratedDatabase();
    try {
      const payment: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x44),
        amount: 1n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      await x402Payments.insertAccepted(db, payment);
      expect(await x402Payments.markSettled(db, payment, hash32(0xee))).toBe(true);
      expect(await x402Payments.markSettled(db, payment, hash32(0xef))).toBe(false);
      expect(await x402Payments.markFailed(db, payment, { reason: "late" })).toBe(false);
      const settled = await x402Payments.get(db, payment);
      expect(settled?.status).toBe(x402Payments.X402_STATUS.settled);
      expect(settled?.txHash).toBe(hash32(0xee));
      expect(settled?.reason).toBeNull();

      const other = { ...payment, nonce: hash32(0x45) };
      await x402Payments.insertAccepted(db, other);
      expect(await x402Payments.markFailed(db, other, { reason: "insufficient_funds", txHash: hash32(0xdd) })).toBe(true);
      const failed = await x402Payments.get(db, other);
      expect(failed?.status).toBe(x402Payments.X402_STATUS.failed);
      expect(failed?.reason).toBe("insufficient_funds");
      expect(failed?.txHash).toBe(hash32(0xdd));
      expect(await x402Payments.markSettled(db, other, hash32(0xee))).toBe(false);
      expect((await x402Payments.get(db, other))?.status).toBe(x402Payments.X402_STATUS.failed);

      const stale = { ...payment, nonce: hash32(0x46), validBefore: 1_000_000_000n };
      await x402Payments.insertAccepted(db, stale);
      expect(await x402Payments.sweep(db)).toBe(1);
      expect(await x402Payments.get(db, stale)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("records a broadcast transaction on an accepted row and lists what is still unresolved", async () => {
    const db = await openMigratedDatabase();
    try {
      const payment: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x50),
        amount: 7n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      const settledLater = { ...payment, nonce: hash32(0x51) };
      await x402Payments.insertAccepted(db, payment);
      await x402Payments.insertAccepted(db, settledLater);

      expect(await x402Payments.recordSettlementAttempt(db, payment, hash32(0x7a))).toBe(true);
      const accepted = await x402Payments.get(db, payment);
      expect(accepted?.status).toBe(x402Payments.X402_STATUS.accepted);
      expect(accepted?.txHash).toBe(hash32(0x7a));

      const pending = await x402Payments.listAccepted(db);
      expect(pending).toHaveLength(2);
      expect(pending.map((row) => row.txHash)).toEqual([hash32(0x7a), null]);
      expect(pending[0]?.validBefore).toBe(1_800_000_000n);

      await x402Payments.markSettled(db, settledLater, hash32(0x7b));
      expect(await x402Payments.listAccepted(db)).toHaveLength(1);
      expect(await x402Payments.recordSettlementAttempt(db, settledLater, hash32(0x7c))).toBe(false);
      expect((await x402Payments.get(db, settledLater))?.txHash).toBe(hash32(0x7b));

      await x402Payments.markFailed(db, payment, { reason: "settlement_reverted" });
      expect(await x402Payments.listAccepted(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
