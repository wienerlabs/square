import type { Hex, PublicClient } from "viem";
import { silentLogger, type GatewayLogger } from "./logger.js";
import type { ReplayStore, UnsettledPayment } from "./replay-store.js";

export type SettlementReceiptStatus = "success" | "reverted" | "unknown";

export type SettlementReceiptLookup = (txHash: Hex) => Promise<SettlementReceiptStatus>;

export type ReconcileClock = () => number | Promise<number>;

export const RECONCILE_REASON = {
  reverted: "settlement_reverted",
  expired: "authorization_expired",
  receiptUnreadable: "settlement_receipt_unreadable",
  unconfirmed: "settlement_unconfirmed",
  awaitingSettlement: "awaiting_settlement",
} as const;

export const DEFAULT_RECEIPT_GRACE_SECONDS = 900;

export interface ReconcileOptions {
  store: ReplayStore;
  receiptStatusOf: SettlementReceiptLookup;
  limit?: number;
  receiptGraceSeconds?: number;
  now?: ReconcileClock;
  logger?: GatewayLogger;
}

export interface ReconcileReport {
  examined: number;
  settled: number;
  failed: number;
  unresolved: number;
}

export function receiptStatusFromClient(client: PublicClient): SettlementReceiptLookup {
  return async (txHash) => {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      return receipt.status === "success" ? "success" : "reverted";
    } catch {
      return "unknown";
    }
  };
}

export function blockTimestampFromClient(client: PublicClient): ReconcileClock {
  return async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp);
}

export const wallClockSeconds: ReconcileClock = () => Math.floor(Date.now() / 1000);

export async function reconcileSettlements(options: ReconcileOptions): Promise<ReconcileReport> {
  const logger = options.logger ?? silentLogger;
  const rows = await options.store.listUnsettled(options.limit);
  const report: ReconcileReport = { examined: rows.length, settled: 0, failed: 0, unresolved: 0 };
  if (rows.length === 0) return report;
  const now = BigInt(await (options.now ?? wallClockSeconds)());
  const grace = BigInt(options.receiptGraceSeconds ?? DEFAULT_RECEIPT_GRACE_SECONDS);
  for (const row of rows) {
    const outcome = await resolve(row, options.receiptStatusOf, now, grace);
    if (outcome.status === "unresolved") {
      await options.store.markChecked(row);
      report.unresolved += 1;
      logger.info("x402 settlement still unresolved", {
        payer: row.payer,
        nonce: row.nonce,
        transaction: row.txHash,
        reason: outcome.reason,
      });
      continue;
    }
    if (outcome.status === "settled") {
      const held = await options.store.markSettled(row, outcome.txHash);
      report.settled += 1;
      logger.info("x402 settlement reconciled as settled", { payer: row.payer, nonce: row.nonce, transaction: outcome.txHash, held });
      continue;
    }
    const held = await options.store.markFailed(row, outcome.reason);
    report.failed += 1;
    logger.warn("x402 settlement reconciled as failed", { payer: row.payer, nonce: row.nonce, reason: outcome.reason, held });
  }
  return report;
}

type Outcome =
  | { status: "unresolved"; reason: string }
  | { status: "settled"; txHash: Hex }
  | { status: "failed"; reason: string };

async function resolve(row: UnsettledPayment, receiptStatusOf: SettlementReceiptLookup, now: bigint, grace: bigint): Promise<Outcome> {
  if (row.txHash !== null) {
    const status = await receiptStatusOf(row.txHash);
    if (status === "success") return { status: "settled", txHash: row.txHash };
    if (status === "reverted") return { status: "failed", reason: RECONCILE_REASON.reverted };
    if (row.validBefore + grace <= now) return { status: "failed", reason: RECONCILE_REASON.unconfirmed };
    return { status: "unresolved", reason: RECONCILE_REASON.receiptUnreadable };
  }
  if (row.validBefore <= now) return { status: "failed", reason: RECONCILE_REASON.expired };
  return { status: "unresolved", reason: RECONCILE_REASON.awaitingSettlement };
}
