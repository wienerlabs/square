import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, toBigInt, type Hex } from "../codec.js";

export const DISPUTE_OUTCOME = { complete: 1, reject: 2, expired: 3 } as const;

export interface DisputeRecord {
  chainId: number;
  jobId: bigint;
  disputer: Hex;
  bond: bigint;
  disputedAt: bigint;
  resolveBy: bigint;
  setVersion: number;
  outcome: number | null;
  providerBps: number | null;
  closed: boolean;
  updatedBlock: bigint;
}

interface DisputeRow {
  chain_id: string;
  job_id: string;
  disputer: Uint8Array;
  bond: string;
  disputed_at: string;
  resolve_by: string;
  set_version: number;
  outcome: number | null;
  provider_bps: number | null;
  closed: boolean;
  updated_block: string;
}

const COLUMNS = "chain_id, job_id, disputer, bond, disputed_at, resolve_by, set_version, outcome, provider_bps, closed, updated_block";

function rowToDispute(row: DisputeRow): DisputeRecord {
  return {
    chainId: Number(row.chain_id),
    jobId: toBigInt(row.job_id),
    disputer: bytesToHex(row.disputer),
    bond: toBigInt(row.bond),
    disputedAt: toBigInt(row.disputed_at),
    resolveBy: toBigInt(row.resolve_by),
    setVersion: row.set_version,
    outcome: row.outcome,
    providerBps: row.provider_bps,
    closed: row.closed,
    updatedBlock: toBigInt(row.updated_block),
  };
}

export async function upsert(db: Database, dispute: DisputeRecord): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into disputes (${COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (chain_id, job_id) do update set
       disputer = excluded.disputer,
       bond = excluded.bond,
       disputed_at = excluded.disputed_at,
       resolve_by = excluded.resolve_by,
       set_version = excluded.set_version,
       outcome = excluded.outcome,
       provider_bps = excluded.provider_bps,
       closed = excluded.closed,
       updated_block = excluded.updated_block
     where disputes.updated_block <= excluded.updated_block`,
    [
      dispute.chainId,
      dispute.jobId.toString(),
      hexToBytes(dispute.disputer),
      dispute.bond.toString(),
      dispute.disputedAt.toString(),
      dispute.resolveBy.toString(),
      dispute.setVersion,
      dispute.outcome,
      dispute.providerBps,
      dispute.closed,
      dispute.updatedBlock.toString(),
    ],
  );
  return rowCount === 1;
}

export async function get(db: Database, chainId: number, jobId: bigint): Promise<DisputeRecord | null> {
  const { rows } = await db.query<DisputeRow>(`select ${COLUMNS} from disputes where chain_id = $1 and job_id = $2`, [chainId, jobId.toString()]);
  const row = rows[0];
  return row === undefined ? null : rowToDispute(row);
}

export async function countOpen(db: Database, chainId: number): Promise<number> {
  const { rows } = await db.query<{ open: string }>(
    `select count(*)::text as open from disputes where chain_id = $1 and not closed`,
    [chainId],
  );
  return Number(rows[0]?.open ?? "0");
}

export async function listOpen(db: Database, chainId: number): Promise<DisputeRecord[]> {
  const { rows } = await db.query<DisputeRow>(`select ${COLUMNS} from disputes where chain_id = $1 and not closed order by resolve_by, job_id`, [chainId]);
  return rows.map(rowToDispute);
}
