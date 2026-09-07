import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, jsonParam, type Hex, type Json } from "../codec.js";

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: Hex;
  status: number;
  response: Json;
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyInput {
  scope: string;
  key: string;
  requestHash: Hex;
  status: number;
  response: Json;
  expiresAt: Date;
}

export type PutIfAbsentResult =
  | { outcome: "stored" }
  | { outcome: "replay"; record: IdempotencyRecord }
  | { outcome: "conflict"; record: IdempotencyRecord };

interface IdempotencyRow {
  scope: string;
  key: string;
  request_hash: Uint8Array;
  status: number;
  response: Json;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS = "scope, key, request_hash, status, response, created_at, expires_at";

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: row.scope,
    key: row.key,
    requestHash: bytesToHex(row.request_hash),
    status: row.status,
    response: row.response,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function get(db: Database, scope: string, key: string): Promise<IdempotencyRecord | null> {
  const { rows } = await db.query<IdempotencyRow>(
    `select ${COLUMNS} from idempotency_keys where scope = $1 and key = $2 and expires_at > now()`,
    [scope, key],
  );
  const row = rows[0];
  return row === undefined ? null : rowToRecord(row);
}

export async function putIfAbsent(db: Database, input: IdempotencyInput): Promise<PutIfAbsentResult> {
  const requestHash = hexToBytes(input.requestHash);
  const { rowCount } = await db.query(
    `insert into idempotency_keys (scope, key, request_hash, status, response, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (scope, key) do update set
       request_hash = excluded.request_hash,
       status = excluded.status,
       response = excluded.response,
       created_at = now(),
       expires_at = excluded.expires_at
     where idempotency_keys.expires_at <= now()`,
    [input.scope, input.key, requestHash, input.status, jsonParam(input.response), input.expiresAt],
  );
  if (rowCount === 1) return { outcome: "stored" };
  const existing = await get(db, input.scope, input.key);
  if (existing === null) return putIfAbsent(db, input);
  return existing.requestHash === bytesToHex(requestHash) ? { outcome: "replay", record: existing } : { outcome: "conflict", record: existing };
}

export async function sweepExpired(db: Database): Promise<number> {
  const { rowCount } = await db.query("delete from idempotency_keys where expires_at <= now() - interval '24 hours'");
  return rowCount;
}
