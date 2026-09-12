import type { Address, Hex } from "viem";
import { x402Payments, type Database } from "@squaresdk/data";

export type ReplayStatus = "accepted" | "settled" | "failed";

export interface ReplayKey {
  chainId: number;
  asset: Address;
  payer: Address;
  nonce: Hex;
}

export interface ReplayEntry extends ReplayKey {
  amount: bigint;
  payTo: Address;
  resource: string;
  validBefore: bigint;
}

export interface ReplayRecord extends ReplayEntry {
  status: ReplayStatus;
  txHash?: Hex;
  reason?: string;
  createdAt: Date;
}

export interface UnsettledPayment extends ReplayKey {
  txHash: Hex | null;
  validBefore: bigint;
}

export interface ReplayStore {
  insertAccepted(entry: ReplayEntry): Promise<boolean>;
  markPending(key: ReplayKey, txHash: Hex): Promise<boolean>;
  markSettled(key: ReplayKey, txHash: Hex | null, reason?: string): Promise<boolean>;
  markFailed(key: ReplayKey, reason: string): Promise<boolean>;
  markChecked(key: ReplayKey): Promise<boolean>;
  has(key: ReplayKey): Promise<boolean>;
  listUnsettled(limit?: number): Promise<UnsettledPayment[]>;
}

export interface MemoryReplayStore extends ReplayStore {
  get(key: ReplayKey): ReplayRecord | undefined;
  size(): number;
}

export const REPLAY_STATUS_CODE: Record<ReplayStatus, number> = {
  accepted: x402Payments.X402_STATUS.accepted,
  settled: x402Payments.X402_STATUS.settled,
  failed: x402Payments.X402_STATUS.failed,
};

export function replayKeyString(key: ReplayKey): string {
  return `${key.chainId}:${key.asset.toLowerCase()}:${key.payer.toLowerCase()}:${key.nonce.toLowerCase()}`;
}

export function memoryReplayStore(): MemoryReplayStore {
  const records = new Map<string, ReplayRecord>();
  const checkedAt = new Map<string, number>();
  let checks = 0;
  const accepted = (key: ReplayKey): ReplayRecord | undefined => {
    const record = records.get(replayKeyString(key));
    return record?.status === "accepted" ? record : undefined;
  };
  return {
    async insertAccepted(entry) {
      const id = replayKeyString(entry);
      if (records.has(id)) {
        return false;
      }
      records.set(id, { ...entry, status: "accepted", createdAt: new Date() });
      return true;
    },
    async markPending(key, txHash) {
      const record = accepted(key);
      if (record === undefined) return false;
      record.txHash = txHash;
      return true;
    },
    async markSettled(key, txHash, reason) {
      const record = accepted(key);
      if (record === undefined) return false;
      record.status = "settled";
      if (txHash !== null) record.txHash = txHash;
      if (reason !== undefined) record.reason = reason;
      return true;
    },
    async markFailed(key, reason) {
      const record = accepted(key);
      if (record === undefined) return false;
      record.status = "failed";
      record.reason = reason;
      return true;
    },
    async markChecked(key) {
      const record = accepted(key);
      if (record === undefined) return false;
      checks += 1;
      checkedAt.set(replayKeyString(key), checks);
      return true;
    },
    async has(key) {
      return records.has(replayKeyString(key));
    },
    async listUnsettled(limit = 100) {
      const open: Array<{ id: string; record: ReplayRecord }> = [];
      for (const [id, record] of records) {
        if (record.status === "accepted") open.push({ id, record });
      }
      open.sort((left, right) => (checkedAt.get(left.id) ?? 0) - (checkedAt.get(right.id) ?? 0));
      return open.slice(0, limit).map(({ record }) => ({
        chainId: record.chainId,
        asset: record.asset,
        payer: record.payer,
        nonce: record.nonce,
        txHash: record.txHash ?? null,
        validBefore: record.validBefore,
      }));
    },
    get(key) {
      return records.get(replayKeyString(key));
    },
    size() {
      return records.size;
    },
  };
}

export function postgresReplayStore(db: Database): ReplayStore {
  return {
    insertAccepted(entry) {
      return x402Payments.insertAccepted(db, entry);
    },
    markPending(key, txHash) {
      return x402Payments.recordSettlementAttempt(db, key, txHash);
    },
    markSettled(key, txHash, reason) {
      return x402Payments.markSettled(db, key, txHash, reason);
    },
    markFailed(key, reason) {
      return x402Payments.markFailed(db, key, { reason });
    },
    markChecked(key) {
      return x402Payments.markChecked(db, key);
    },
    has(key) {
      return x402Payments.exists(db, key);
    },
    async listUnsettled(limit = 100) {
      const rows = await x402Payments.listAccepted(db, limit);
      return rows.map((row) => ({
        chainId: row.chainId,
        asset: row.asset as Address,
        payer: row.payer as Address,
        nonce: row.nonce as Hex,
        txHash: row.txHash as Hex | null,
        validBefore: row.validBefore,
      }));
    },
  };
}
