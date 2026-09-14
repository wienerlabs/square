import type { Database } from "../database.js";
import { pageSql, type ListPage } from "../pagination.js";
import {
  bytesToHex,
  hexToBytes,
  nullableBigIntParam,
  nullableBytesToHex,
  nullableHexToBytes,
  nullableToBigInt,
  toBigInt,
  type Hex,
} from "../codec.js";

export const JOB_STATUS = { open: 0, funded: 1, submitted: 2, completed: 3, rejected: 4, expired: 5 } as const;

export interface JobRecord {
  chainId: number;
  jobId: bigint;
  client: Hex;
  provider: Hex | null;
  evaluator: Hex;
  hook: Hex | null;
  description: string;
  budget: bigint;
  status: number;
  expiredAt: bigint;
  createdAt: bigint;
  fundedAt: bigint | null;
  submittedAt: bigint | null;
  challengeEnd: bigint | null;
  platformFeeBp: number | null;
  evaluatorFeeBp: number | null;
  deliverable: Hex | null;
  payee: Hex | null;
  providerBps: number | null;
  reason: Hex | null;
  disputed: boolean;
  agentId: bigint | null;
  updatedBlock: bigint;
  refundReason: string | null;
}

interface JobRow {
  chain_id: string;
  job_id: string;
  client: Uint8Array;
  provider: Uint8Array | null;
  evaluator: Uint8Array;
  hook: Uint8Array | null;
  description: string;
  budget: string;
  status: number;
  expired_at: string;
  created_at: string;
  funded_at: string | null;
  submitted_at: string | null;
  challenge_end: string | null;
  platform_fee_bp: number | null;
  evaluator_fee_bp: number | null;
  deliverable: Uint8Array | null;
  payee: Uint8Array | null;
  provider_bps: number | null;
  reason: Uint8Array | null;
  disputed: boolean;
  agent_id: string | null;
  updated_block: string;
  refund_reason: string | null;
}

const COLUMNS =
  "chain_id, job_id, client, provider, evaluator, hook, description, budget, status, expired_at, created_at, funded_at, submitted_at, challenge_end, platform_fee_bp, evaluator_fee_bp, deliverable, payee, provider_bps, reason, disputed, agent_id, updated_block, refund_reason";

const QUALIFIED_COLUMNS = COLUMNS.split(", ")
  .map((column) => `jobs.${column}`)
  .join(", ");

const OPEN_FILTER = `chain_id = $1 and status in (${JOB_STATUS.open}, ${JOB_STATUS.funded})`;
const IN_CHALLENGE_WINDOW_FILTER = `chain_id = $1 and status = ${JOB_STATUS.submitted} and not disputed and challenge_end > $2`;
const FINALIZABLE_FILTER = `chain_id = $1 and status = ${JOB_STATUS.submitted} and not disputed and challenge_end is not null and challenge_end <= $2`;

async function count(db: Database, filter: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ total: string }>(`select count(*)::text as total from jobs where ${filter}`, params);
  return Number(rows[0]?.total ?? "0");
}

function rowToJob(row: JobRow): JobRecord {
  return {
    chainId: Number(row.chain_id),
    jobId: toBigInt(row.job_id),
    client: bytesToHex(row.client),
    provider: nullableBytesToHex(row.provider),
    evaluator: bytesToHex(row.evaluator),
    hook: nullableBytesToHex(row.hook),
    description: row.description,
    budget: toBigInt(row.budget),
    status: row.status,
    expiredAt: toBigInt(row.expired_at),
    createdAt: toBigInt(row.created_at),
    fundedAt: nullableToBigInt(row.funded_at),
    submittedAt: nullableToBigInt(row.submitted_at),
    challengeEnd: nullableToBigInt(row.challenge_end),
    platformFeeBp: row.platform_fee_bp,
    evaluatorFeeBp: row.evaluator_fee_bp,
    deliverable: nullableBytesToHex(row.deliverable),
    payee: nullableBytesToHex(row.payee),
    providerBps: row.provider_bps,
    reason: nullableBytesToHex(row.reason),
    disputed: row.disputed,
    agentId: nullableToBigInt(row.agent_id),
    updatedBlock: toBigInt(row.updated_block),
    refundReason: row.refund_reason,
  };
}

export async function upsert(db: Database, job: JobRecord): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into jobs (${COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     on conflict (chain_id, job_id) do update set
       client = excluded.client,
       provider = excluded.provider,
       evaluator = excluded.evaluator,
       hook = excluded.hook,
       description = excluded.description,
       budget = excluded.budget,
       status = excluded.status,
       expired_at = excluded.expired_at,
       created_at = excluded.created_at,
       funded_at = excluded.funded_at,
       submitted_at = excluded.submitted_at,
       challenge_end = excluded.challenge_end,
       platform_fee_bp = excluded.platform_fee_bp,
       evaluator_fee_bp = excluded.evaluator_fee_bp,
       deliverable = excluded.deliverable,
       payee = excluded.payee,
       provider_bps = excluded.provider_bps,
       reason = excluded.reason,
       disputed = excluded.disputed,
       agent_id = excluded.agent_id,
       updated_block = excluded.updated_block,
       refund_reason = excluded.refund_reason
     where jobs.updated_block <= excluded.updated_block`,
    [
      job.chainId,
      job.jobId.toString(),
      hexToBytes(job.client),
      nullableHexToBytes(job.provider),
      hexToBytes(job.evaluator),
      nullableHexToBytes(job.hook),
      job.description,
      job.budget.toString(),
      job.status,
      job.expiredAt.toString(),
      job.createdAt.toString(),
      nullableBigIntParam(job.fundedAt),
      nullableBigIntParam(job.submittedAt),
      nullableBigIntParam(job.challengeEnd),
      job.platformFeeBp,
      job.evaluatorFeeBp,
      nullableHexToBytes(job.deliverable),
      nullableHexToBytes(job.payee),
      job.providerBps,
      nullableHexToBytes(job.reason),
      job.disputed,
      nullableBigIntParam(job.agentId),
      job.updatedBlock.toString(),
      job.refundReason,
    ],
  );
  return rowCount === 1;
}

export async function get(db: Database, chainId: number, jobId: bigint): Promise<JobRecord | null> {
  const { rows } = await db.query<JobRow>(`select ${COLUMNS} from jobs where chain_id = $1 and job_id = $2`, [chainId, jobId.toString()]);
  const row = rows[0];
  return row === undefined ? null : rowToJob(row);
}

export async function listOpen(db: Database, chainId: number, page?: ListPage): Promise<JobRecord[]> {
  const params: unknown[] = [chainId];
  const { cursor, order, bound } = pageSql(page, params, "job_id");
  const { rows } = await db.query<JobRow>(`select ${COLUMNS} from jobs where ${OPEN_FILTER}${cursor} order by ${order}${bound}`, params);
  return rows.map(rowToJob);
}

export async function countOpen(db: Database, chainId: number): Promise<number> {
  return count(db, OPEN_FILTER, [chainId]);
}

export async function listByProvider(db: Database, chainId: number, provider: Hex, page?: ListPage): Promise<JobRecord[]> {
  const params: unknown[] = [chainId, hexToBytes(provider)];
  const { cursor, order, bound } = pageSql(page, params, "job_id");
  const { rows } = await db.query<JobRow>(
    `select ${COLUMNS} from jobs where chain_id = $1 and provider = $2${cursor} order by ${order}${bound}`,
    params,
  );
  return rows.map(rowToJob);
}

export async function listInChallengeWindow(db: Database, chainId: number, now: bigint, page?: ListPage): Promise<JobRecord[]> {
  const params: unknown[] = [chainId, now.toString()];
  const { cursor, order, bound } = pageSql(page, params, "challenge_end, job_id");
  const { rows } = await db.query<JobRow>(
    `select ${COLUMNS} from jobs where ${IN_CHALLENGE_WINDOW_FILTER}${cursor} order by ${order}${bound}`,
    params,
  );
  return rows.map(rowToJob);
}

export async function countInChallengeWindow(db: Database, chainId: number, now: bigint): Promise<number> {
  return count(db, IN_CHALLENGE_WINDOW_FILTER, [chainId, now.toString()]);
}

export async function listFinalizable(db: Database, chainId: number, now: bigint, evaluator?: Hex, page?: ListPage): Promise<JobRecord[]> {
  const params: unknown[] = [chainId, now.toString()];
  let filter = "";
  if (evaluator !== undefined) {
    params.push(hexToBytes(evaluator));
    filter = ` and evaluator = $${params.length}`;
  }
  const { cursor, order, bound } = pageSql(page, params, "challenge_end, job_id");
  const { rows } = await db.query<JobRow>(
    `select ${COLUMNS} from jobs where ${FINALIZABLE_FILTER}${filter}${cursor} order by ${order}${bound}`,
    params,
  );
  return rows.map(rowToJob);
}

export async function countFinalizable(db: Database, chainId: number, now: bigint): Promise<number> {
  return count(db, FINALIZABLE_FILTER, [chainId, now.toString()]);
}

export async function listDisputedSubmitted(db: Database, chainId: number, evaluator?: Hex): Promise<JobRecord[]> {
  const filter = evaluator === undefined ? "" : " and evaluator = $2";
  const params: unknown[] = evaluator === undefined ? [chainId] : [chainId, hexToBytes(evaluator)];
  const { rows } = await db.query<JobRow>(
    `select ${COLUMNS} from jobs where chain_id = $1 and status = ${JOB_STATUS.submitted} and disputed${filter} order by job_id`,
    params,
  );
  return rows.map(rowToJob);
}

export async function listExpiredDisputed(db: Database, chainId: number, evaluator?: Hex): Promise<JobRecord[]> {
  const filter = evaluator === undefined ? "" : " and jobs.evaluator = $2";
  const params: unknown[] = evaluator === undefined ? [chainId] : [chainId, hexToBytes(evaluator)];
  const { rows } = await db.query<JobRow>(
    `select ${QUALIFIED_COLUMNS} from jobs
     join disputes on disputes.chain_id = jobs.chain_id and disputes.job_id = jobs.job_id
     where jobs.chain_id = $1 and jobs.status = ${JOB_STATUS.expired} and not disputes.closed${filter}
     order by jobs.job_id`,
    params,
  );
  return rows.map(rowToJob);
}

export async function listExpiredWithAgent(
  db: Database,
  chainId: number,
  evaluator?: Hex,
  limit?: number,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<JobRecord[]> {
  const params: unknown[] = [chainId, now.toString()];
  let filter = "";
  if (evaluator !== undefined) {
    params.push(hexToBytes(evaluator));
    filter = ` and jobs.evaluator = $${params.length}`;
  }
  let bound = "";
  if (limit !== undefined) {
    params.push(limit);
    bound = ` limit $${params.length}`;
  }
  const { rows } = await db.query<JobRow>(
    `select ${QUALIFIED_COLUMNS} from jobs
     left join keeper_job_state state on state.chain_id = jobs.chain_id and state.job_id = jobs.job_id
     where jobs.chain_id = $1 and jobs.status = ${JOB_STATUS.expired} and jobs.agent_id is not null${filter}
       and state.expiry_recorded_at is null
       and coalesce(state.expiry_gave_up, false) = false
       and (state.expiry_next_at is null or state.expiry_next_at <= $2)
     order by coalesce(state.expiry_next_at, 0), jobs.job_id${bound}`,
    params,
  );
  return rows.map(rowToJob);
}
