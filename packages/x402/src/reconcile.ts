import type { Hex, PublicClient } from "viem";
import { silentLogger, type GatewayLogger } from "./logger.js";
import type { ReplayStore, UnsettledPayment } from "./replay-store.js";

export type SettlementReceiptStatus = "success" | "reverted" | "unknown";

export type SettlementReceiptLookup = (txHash: Hex) => Promise<SettlementReceiptStatus>;

export const RECONCILE_REASON = {
  reverted: "settlement_reverted",
  expired: "authorization_expired",
} as const;

export interface ReconcileOptions {
  store: ReplayStore;
  receiptStatusOf: SettlementReceiptLookup;
  limit?: number;
  now?: () => number;
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

export async function reconcileSettlements(options: ReconcileOptions): Promise<ReconcileReport> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const rows = await options.store.listUnsettled(options.limit);
  const report: ReconcileReport = { examined: rows.length, settled: 0, failed: 0, unresolved: 0 };
  for (const row of rows) {
    const outcome = await resolve(row, options.receiptStatusOf, BigInt(now()));
    if (outcome === "unresolved") {
      report.unresolved += 1;
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

type Outcome = "unresolved" | { status: "settled"; txHash: Hex } | { status: "failed"; reason: string };

async function resolve(row: UnsettledPayment, receiptStatusOf: SettlementReceiptLookup, now: bigint): Promise<Outcome> {
  if (row.txHash !== null) {
    const status = await receiptStatusOf(row.txHash);
    if (status === "success") return { status: "settled", txHash: row.txHash };
    if (status === "reverted") return { status: "failed", reason: RECONCILE_REASON.reverted };
  }
  return row.validBefore <= now ? { status: "failed", reason: RECONCILE_REASON.expired } : "unresolved";
}
