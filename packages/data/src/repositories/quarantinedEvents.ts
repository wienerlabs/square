import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, toBigInt, type Hex } from "../codec.js";

export type QuarantineStage = "journal" | "reduce";

export interface QuarantinedEventInput {
  chainId: number;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  contract: string;
  eventName: string;
  stage: QuarantineStage;
  error: string;
}

export interface QuarantinedEventRecord extends QuarantinedEventInput {
  createdAt: Date;
}

interface QuarantinedEventRow {
  chain_id: string;
  block_number: string;
  log_index: number;
  tx_hash: Uint8Array;
  contract: string;
  event_name: string;
  stage: QuarantineStage;
  error: string;
  created_at: Date;
}

const COLUMNS = "chain_id, block_number, log_index, tx_hash, contract, event_name, stage, error, created_at";

export async function record(db: Database, input: QuarantinedEventInput): Promise<void> {
  await db.query(
    `insert into quarantined_events (chain_id, block_number, log_index, tx_hash, contract, event_name, stage, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chain_id, block_number, log_index) do update set
       tx_hash = excluded.tx_hash,
       contract = excluded.contract,
       event_name = excluded.event_name,
       stage = excluded.stage,
       error = excluded.error,
       created_at = now()`,
    [
      input.chainId,
      input.blockNumber.toString(),
      input.logIndex,
      hexToBytes(input.txHash),
      input.contract,
      input.eventName,
      input.stage,
      input.error,
    ],
  );
}

export async function recent(db: Database, chainId: number, limit = 100): Promise<QuarantinedEventRecord[]> {
  const { rows } = await db.query<QuarantinedEventRow>(
    `select ${COLUMNS} from quarantined_events
     where chain_id = $1 order by block_number desc, log_index desc limit $2`,
    [chainId, limit],
  );
  return rows.map((row) => ({
    chainId: Number(row.chain_id),
    blockNumber: toBigInt(row.block_number),
    logIndex: row.log_index,
    txHash: bytesToHex(row.tx_hash),
    contract: row.contract,
    eventName: row.event_name,
    stage: row.stage,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export async function count(db: Database, chainId: number): Promise<number> {
  const { rows } = await db.query<{ quarantined: string }>(
    `select count(*)::text as quarantined from quarantined_events where chain_id = $1`,
    [chainId],
  );
  return Number(rows[0]?.quarantined ?? "0");
}
