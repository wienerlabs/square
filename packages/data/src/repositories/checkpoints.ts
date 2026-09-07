import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, toBigInt, type Hex } from "../codec.js";
import type { IndexedContract } from "../contracts.js";

export interface CheckpointRecord {
  chainId: number;
  contract: IndexedContract;
  address: Hex;
  lastBlock: bigint;
  updatedAt: Date;
}

export interface CheckpointInput {
  chainId: number;
  contract: IndexedContract;
  address: Hex;
  lastBlock: bigint;
}

interface CheckpointRow {
  chain_id: string;
  contract: IndexedContract;
  address: Uint8Array;
  last_block: string;
  updated_at: Date;
}

export async function get(db: Database, chainId: number, contract: IndexedContract): Promise<CheckpointRecord | null> {
  const { rows } = await db.query<CheckpointRow>(
    "select chain_id, contract, address, last_block, updated_at from indexer_checkpoints where chain_id = $1 and contract = $2",
    [chainId, contract],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        chainId: Number(row.chain_id),
        contract: row.contract,
        address: bytesToHex(row.address),
        lastBlock: toBigInt(row.last_block),
        updatedAt: row.updated_at,
      };
}

export async function set(db: Database, checkpoint: CheckpointInput): Promise<void> {
  await db.query(
    `insert into indexer_checkpoints (chain_id, contract, address, last_block, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (chain_id, contract) do update set
       address = excluded.address,
       last_block = excluded.last_block,
       updated_at = now()`,
    [checkpoint.chainId, checkpoint.contract, hexToBytes(checkpoint.address), checkpoint.lastBlock.toString()],
  );
}
