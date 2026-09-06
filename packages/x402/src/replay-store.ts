import type { Address, Hex } from "viem";

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

export interface ReplayStore {
  insertAccepted(entry: ReplayEntry): Promise<boolean>;
  markSettled(key: ReplayKey, txHash: Hex): Promise<void>;
  markFailed(key: ReplayKey, reason: string): Promise<void>;
  has(key: ReplayKey): Promise<boolean>;
}

export interface MemoryReplayStore extends ReplayStore {
  get(key: ReplayKey): ReplayRecord | undefined;
  size(): number;
}

export interface SqlDatabase {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export const REPLAY_STATUS_CODE: Record<ReplayStatus, number> = {
  accepted: 1,
  settled: 2,
  failed: 3,
};

export const X402_PAYMENTS_DDL = `create table if not exists x402_payments (
  chain_id bigint not null,
  asset bytea not null,
  payer bytea not null,
  nonce bytea not null,
  amount numeric not null,
  pay_to bytea not null,
  resource text not null,
  tx_hash bytea,
  status smallint not null,
  valid_before bigint not null,
  created_at timestamptz not null default now(),
  primary key (chain_id, asset, payer, nonce)
);`;

export function replayKeyString(key: ReplayKey): string {
  return `${key.chainId}:${key.asset.toLowerCase()}:${key.payer.toLowerCase()}:${key.nonce.toLowerCase()}`;
}

export function memoryReplayStore(): MemoryReplayStore {
  const records = new Map<string, ReplayRecord>();
  return {
    async insertAccepted(entry) {
      const id = replayKeyString(entry);
      if (records.has(id)) {
        return false;
      }
      records.set(id, { ...entry, status: "accepted", createdAt: new Date() });
      return true;
    },
    async markSettled(key, txHash) {
      const record = records.get(replayKeyString(key));
      if (record) {
        record.status = "settled";
        record.txHash = txHash;
      }
    },
    async markFailed(key, reason) {
      const record = records.get(replayKeyString(key));
      if (record && record.status !== "settled") {
        record.status = "failed";
        record.reason = reason;
      }
    },
    async has(key) {
      return records.has(replayKeyString(key));
    },
    get(key) {
      return records.get(replayKeyString(key));
    },
    size() {
      return records.size;
    },
  };
}

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

function keyParams(key: ReplayKey): unknown[] {
  return [key.chainId, hexToBytes(key.asset), hexToBytes(key.payer), hexToBytes(key.nonce)];
}

const KEY_WHERE = "chain_id = $1 and asset = $2 and payer = $3 and nonce = $4";

export function postgresReplayStore(db: SqlDatabase): ReplayStore {
  return {
    async insertAccepted(entry) {
      const result = await db.query(
        `insert into x402_payments
           (chain_id, asset, payer, nonce, amount, pay_to, resource, status, valid_before, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         on conflict do nothing`,
        [
          ...keyParams(entry),
          entry.amount.toString(),
          hexToBytes(entry.payTo),
          entry.resource,
          REPLAY_STATUS_CODE.accepted,
          entry.validBefore.toString(),
        ]
      );
      return result.rowCount === 1;
    },
    async markSettled(key, txHash) {
      await db.query(
        `update x402_payments set status = $5, tx_hash = $6 where ${KEY_WHERE}`,
        [...keyParams(key), REPLAY_STATUS_CODE.settled, hexToBytes(txHash)]
      );
    },
    async markFailed(key, reason) {
      void reason;
      await db.query(
        `update x402_payments set status = $5 where ${KEY_WHERE} and status <> ${REPLAY_STATUS_CODE.settled}`,
        [...keyParams(key), REPLAY_STATUS_CODE.failed]
      );
    },
    async has(key) {
      const result = await db.query(
        `select 1 from x402_payments where ${KEY_WHERE} limit 1`,
        keyParams(key)
      );
      return result.rows.length > 0 || (result.rowCount ?? 0) > 0;
    },
  };
}
