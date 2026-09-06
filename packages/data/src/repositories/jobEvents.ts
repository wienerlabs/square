import type { Database } from "../database.js";
import { hexToBytes, jsonParam, nullableBigIntParam, type Hex, type Json } from "../codec.js";
import type { IndexedContract } from "../contracts.js";

export interface JobEventRecord {
  chainId: number;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  contract: IndexedContract;
  name: string;
  jobId: bigint | null;
  args: Json;
}

export async function insertIfAbsent(db: Database, event: JobEventRecord): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into job_events (chain_id, block_number, log_index, tx_hash, contract, name, job_id, args)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chain_id, block_number, log_index) do nothing`,
    [
      event.chainId,
      event.blockNumber.toString(),
      event.logIndex,
      hexToBytes(event.txHash),
      event.contract,
      event.name,
      nullableBigIntParam(event.jobId),
      jsonParam(event.args),
    ],
  );
  return rowCount === 1;
}
