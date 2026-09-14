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

      expect(await x402Payments.exists(db, payment)).toBe(true);
      expect(await x402Payments.exists(db, { ...payment, nonce: hash32(0x99) })).toBe(false);

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
      expect(await x402Payments.exists(db, payment)).toBe(true);
      expect(await x402Payments.exists(db, { ...payment, nonce: hash32(0x99) })).toBe(false);

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
  it("settles a payment whose transaction hash never arrived, and says so in the reason", async () => {
    const db = await openMigratedDatabase();
    try {
      const payment: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x51),
        amount: 25n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      await x402Payments.insertAccepted(db, payment);

      expect(await x402Payments.markSettled(db, payment, null, "settled_without_transaction_hash")).toBe(true);

      const settled = await x402Payments.get(db, payment);
      expect(settled?.status).toBe(x402Payments.X402_STATUS.settled);
      expect(settled?.txHash).toBeNull();
      expect(settled?.reason).toBe("settled_without_transaction_hash");
      expect(await x402Payments.listAccepted(db)).toEqual([]);
      expect(await x402Payments.markFailed(db, payment, { reason: "authorization_expired" })).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("keeps a hash already on the row when a later settle carries none", async () => {
    const db = await openMigratedDatabase();
    try {
      const payment: x402Payments.AcceptedPayment = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        nonce: hash32(0x52),
        amount: 25n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      await x402Payments.insertAccepted(db, payment);
      await x402Payments.recordSettlementAttempt(db, payment, hash32(0x8a));

      await x402Payments.markSettled(db, payment, null, "settled_without_transaction_hash");

      expect((await x402Payments.get(db, payment))?.txHash).toBe(hash32(0x8a));
    } finally {
      await db.close();
    }
  });

  it("sends a row the reconciler could not close to the back of the queue", async () => {
    const db = await openMigratedDatabase();
    try {
      const base = {
        chainId: 5042002,
        asset: address(0xa0),
        payer: address(0xb1),
        amount: 25n,
        payTo: address(0xc2),
        resource: "/v1/resolve",
        validBefore: 1_800_000_000n,
      };
      const first = { ...base, nonce: hash32(0x61) };
      const second = { ...base, nonce: hash32(0x62) };
      const third = { ...base, nonce: hash32(0x63) };
      await x402Payments.insertAccepted(db, first);
      await x402Payments.insertAccepted(db, second);
      await x402Payments.insertAccepted(db, third);

      expect((await x402Payments.listAccepted(db)).map((row) => row.nonce)).toEqual([first.nonce, second.nonce, third.nonce]);

      expect(await x402Payments.markChecked(db, first)).toBe(true);
      expect(await x402Payments.markChecked(db, second)).toBe(true);

      expect((await x402Payments.listAccepted(db)).map((row) => row.nonce)).toEqual([third.nonce, first.nonce, second.nonce]);
      expect((await x402Payments.listAccepted(db, 1)).map((row) => row.nonce)).toEqual([third.nonce]);

      await x402Payments.markSettled(db, third, hash32(0x9a));
      expect(await x402Payments.markChecked(db, third)).toBe(false);
    } finally {
      await db.close();
    }
  });
});
