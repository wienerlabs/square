import type { Database } from "../database.js";
import { nullableToBigInt, toBigInt } from "../codec.js";

export interface KeeperJobState {
  chainId: number;
  jobId: bigint;
  finalizeGaveUp: boolean;
  expiryRecordedAt: Date | null;
  expiryAttempts: number;
  expiryNextAt: bigint | null;
  expiryGaveUp: boolean;
  unprofitableJournaledAt: Date | null;
  heldReason: string | null;
  heldSince: bigint | null;
  updatedAt: Date;
}

interface KeeperJobStateRow {
  chain_id: string;
  job_id: string;
  finalize_gave_up: boolean;
  expiry_recorded_at: Date | null;
  expiry_attempts: number;
  expiry_next_at: string | null;
  expiry_gave_up: boolean;
  unprofitable_journaled_at: Date | null;
  held_reason: string | null;
  held_since: string | null;
  updated_at: Date;
}

const COLUMNS =
  "chain_id, job_id, finalize_gave_up, expiry_recorded_at, expiry_attempts, expiry_next_at, expiry_gave_up, unprofitable_journaled_at, held_reason, held_since, updated_at";

function rowToState(row: KeeperJobStateRow): KeeperJobState {
  return {
    chainId: Number(row.chain_id),
    jobId: toBigInt(row.job_id),
    finalizeGaveUp: row.finalize_gave_up,
    expiryRecordedAt: row.expiry_recorded_at,
    expiryAttempts: row.expiry_attempts,
    expiryNextAt: nullableToBigInt(row.expiry_next_at),
    expiryGaveUp: row.expiry_gave_up,
    unprofitableJournaledAt: row.unprofitable_journaled_at,
    heldReason: row.held_reason,
    heldSince: nullableToBigInt(row.held_since),
    updatedAt: row.updated_at,
  };
}

export async function get(db: Database, chainId: number, jobId: bigint): Promise<KeeperJobState | null> {
  const { rows } = await db.query<KeeperJobStateRow>(
    `select ${COLUMNS} from keeper_job_state where chain_id = $1 and job_id = $2`,
    [chainId, jobId.toString()],
  );
  const row = rows[0];
  return row === undefined ? null : rowToState(row);
}

export async function listFinalizeGaveUp(db: Database, chainId: number): Promise<bigint[]> {
  const { rows } = await db.query<{ job_id: string }>(
    `select job_id from keeper_job_state where chain_id = $1 and finalize_gave_up order by job_id`,
    [chainId],
  );
  return rows.map((row) => toBigInt(row.job_id));
}

export async function markFinalizeGaveUp(db: Database, chainId: number, jobId: bigint): Promise<void> {
  await db.query(
    `insert into keeper_job_state (chain_id, job_id, finalize_gave_up)
     values ($1, $2, true)
     on conflict (chain_id, job_id) do update set finalize_gave_up = true, updated_at = now()`,
    [chainId, jobId.toString()],
  );
}

export async function clearFinalizeGiveUp(db: Database, chainId: number, jobId: bigint): Promise<number> {
  const { rowCount } = await db.query(
    `update keeper_job_state set finalize_gave_up = false, updated_at = now()
     where chain_id = $1 and job_id = $2 and finalize_gave_up`,
    [chainId, jobId.toString()],
  );
  return rowCount;
}

export async function markExpiryRecorded(db: Database, chainId: number, jobId: bigint): Promise<void> {
  await db.query(
    `insert into keeper_job_state (chain_id, job_id, expiry_recorded_at)
     values ($1, $2, now())
     on conflict (chain_id, job_id) do update set expiry_recorded_at = coalesce(keeper_job_state.expiry_recorded_at, now()), updated_at = now()`,
    [chainId, jobId.toString()],
  );
}

export async function bumpExpiryAttempts(db: Database, chainId: number, jobId: bigint): Promise<number> {
  const { rows } = await db.query<{ expiry_attempts: number }>(
    `insert into keeper_job_state (chain_id, job_id, expiry_attempts)
     values ($1, $2, 1)
     on conflict (chain_id, job_id) do update set expiry_attempts = keeper_job_state.expiry_attempts + 1, updated_at = now()
     returning expiry_attempts`,
    [chainId, jobId.toString()],
  );
  return rows[0]?.expiry_attempts ?? 1;
}

export async function scheduleExpiryRetry(
  db: Database,
  chainId: number,
  jobId: bigint,
  nextAttemptAt: bigint,
  gaveUp: boolean,
): Promise<void> {
  await db.query(
    `update keeper_job_state set expiry_next_at = $3, expiry_gave_up = $4, updated_at = now()
     where chain_id = $1 and job_id = $2`,
    [chainId, jobId.toString(), nextAttemptAt.toString(), gaveUp],
  );
}

export async function listExpiryGaveUp(db: Database, chainId: number): Promise<bigint[]> {
  const { rows } = await db.query<{ job_id: string }>(
    `select job_id from keeper_job_state where chain_id = $1 and expiry_gave_up order by job_id`,
    [chainId],
  );
  return rows.map((row) => toBigInt(row.job_id));
}

export async function clearExpiryGiveUp(db: Database, chainId: number, jobId: bigint): Promise<number> {
  const { rowCount } = await db.query(
    `update keeper_job_state
     set expiry_gave_up = false, expiry_attempts = 0, expiry_next_at = null, updated_at = now()
     where chain_id = $1 and job_id = $2 and expiry_gave_up`,
    [chainId, jobId.toString()],
  );
  return rowCount;
}

export async function markUnprofitableJournaled(db: Database, chainId: number, jobId: bigint): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into keeper_job_state (chain_id, job_id, unprofitable_journaled_at)
     values ($1, $2, now())
     on conflict (chain_id, job_id) do update set unprofitable_journaled_at = now(), updated_at = now()
     where keeper_job_state.unprofitable_journaled_at is null`,
    [chainId, jobId.toString()],
  );
  return rowCount > 0;
}

export interface KeeperHold {
  jobId: bigint;
  reason: string;
  since: bigint;
}

interface KeeperHoldRow {
  job_id: string;
  held_reason: string;
  held_since: string;
}

export async function hold(db: Database, chainId: number, jobId: bigint, reason: string, since: bigint): Promise<bigint> {
  const { rows } = await db.query<{ held_since: string }>(
    `insert into keeper_job_state (chain_id, job_id, held_reason, held_since)
     values ($1, $2, $3, $4)
     on conflict (chain_id, job_id) do update
       set held_reason = excluded.held_reason,
           held_since = case
             when keeper_job_state.held_reason = excluded.held_reason then coalesce(keeper_job_state.held_since, excluded.held_since)
             else excluded.held_since
           end,
           updated_at = now()
     returning held_since`,
    [chainId, jobId.toString(), reason, since.toString()],
  );
  const row = rows[0];
  return row === undefined ? since : toBigInt(row.held_since);
}

export async function releaseHold(db: Database, chainId: number, jobId: bigint): Promise<boolean> {
  const { rowCount } = await db.query(
    `update keeper_job_state set held_reason = null, held_since = null, updated_at = now()
     where chain_id = $1 and job_id = $2 and held_reason is not null`,
    [chainId, jobId.toString()],
  );
  return rowCount > 0;
}

export async function listHeld(db: Database, chainId: number): Promise<KeeperHold[]> {
  const { rows } = await db.query<KeeperHoldRow>(
    `select job_id, held_reason, held_since from keeper_job_state
     where chain_id = $1 and held_reason is not null order by job_id`,
    [chainId],
  );
  return rows.map((row) => ({ jobId: toBigInt(row.job_id), reason: row.held_reason, since: toBigInt(row.held_since) }));
}

export async function countHeld(db: Pick<Database, "query">, chainId: number): Promise<Record<string, number>> {
  const { rows } = await db.query<{ held_reason: string; held: string }>(
    `select held_reason, count(*) as held from keeper_job_state
     where chain_id = $1 and held_reason is not null group by held_reason order by held_reason`,
    [chainId],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.held_reason] = Number(row.held);
  return counts;
}
