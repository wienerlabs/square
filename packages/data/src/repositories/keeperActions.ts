import type { Database } from "../database.js";
import { hexToBytes, nullableBigIntParam, nullableBytesToHex, nullableToBigInt, toBigInt, type Hex } from "../codec.js";

export type KeeperAction = "finalize" | "finalizeDecided" | "lapse" | "recordExpiry" | "skipped";

export interface KeeperActionInput {
  chainId: number;
  jobId: bigint;
  action: KeeperAction;
  txHash?: Hex;
  gasUsed?: bigint;
  feeEarned?: bigint;
  reason?: string;
  gaveUp?: boolean;
}

export interface KeeperActionRecord {
  id: bigint;
  chainId: number;
  jobId: bigint;
  action: KeeperAction;
  txHash: Hex | null;
  gasUsed: bigint | null;
  feeEarned: bigint | null;
  reason: string | null;
  gaveUp: boolean;
  createdAt: Date;
}

interface KeeperActionRow {
  id: string;
  chain_id: string;
  job_id: string;
  action: KeeperAction;
  tx_hash: Uint8Array | null;
  gas_used: string | null;
  fee_earned: string | null;
  reason: string | null;
  gave_up: boolean;
  created_at: Date;
}

export async function append(db: Database, input: KeeperActionInput): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>(
    `insert into keeper_actions (chain_id, job_id, action, tx_hash, gas_used, fee_earned, reason, gave_up)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      input.chainId,
      input.jobId.toString(),
      input.action,
      input.txHash === undefined ? null : hexToBytes(input.txHash),
      nullableBigIntParam(input.gasUsed ?? null),
      nullableBigIntParam(input.feeEarned ?? null),
      input.reason ?? null,
      input.gaveUp ?? false,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("keeper action insert returned no row");
  return toBigInt(row.id);
}

export async function recent(db: Database, chainId: number, limit = 100): Promise<KeeperActionRecord[]> {
  const { rows } = await db.query<KeeperActionRow>(
    `select id, chain_id, job_id, action, tx_hash, gas_used, fee_earned, reason, gave_up, created_at
     from keeper_actions where chain_id = $1 order by id desc limit $2`,
    [chainId, limit],
  );
  return rows.map((row) => ({
    id: toBigInt(row.id),
    chainId: Number(row.chain_id),
    jobId: toBigInt(row.job_id),
    action: row.action,
    txHash: nullableBytesToHex(row.tx_hash),
    gasUsed: nullableToBigInt(row.gas_used),
    feeEarned: nullableToBigInt(row.fee_earned),
    reason: row.reason,
    gaveUp: row.gave_up,
    createdAt: row.created_at,
  }));
}

export async function listGaveUp(db: Database, chainId: number): Promise<bigint[]> {
  const { rows } = await db.query<{ job_id: string }>(
    `select distinct job_id from keeper_actions where chain_id = $1 and gave_up order by job_id`,
    [chainId],
  );
  return rows.map((row) => toBigInt(row.job_id));
}

export async function clearGiveUp(db: Database, chainId: number, jobId: bigint): Promise<number> {
  const { rowCount } = await db.query(
    `update keeper_actions set gave_up = false where chain_id = $1 and job_id = $2 and gave_up`,
    [chainId, jobId.toString()],
  );
  return rowCount;
}

export async function sweep(db: Database): Promise<number> {
  const { rowCount } = await db.query("delete from keeper_actions where created_at < now() - interval '90 days'");
  return rowCount;
}
