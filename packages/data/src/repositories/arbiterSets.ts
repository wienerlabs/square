import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, type Hex } from "../codec.js";

export interface ArbiterSetRecord {
  chainId: number;
  version: number;
  arbiters: Hex[];
  threshold: number;
}

interface ArbiterSetRow {
  chain_id: string;
  version: number;
  arbiters: Uint8Array[];
  threshold: number;
}

const COLUMNS = "chain_id, version, arbiters, threshold";

function rowToArbiterSet(row: ArbiterSetRow): ArbiterSetRecord {
  return { chainId: Number(row.chain_id), version: row.version, arbiters: row.arbiters.map(bytesToHex), threshold: row.threshold };
}

export async function upsert(db: Database, set: ArbiterSetRecord): Promise<void> {
  await db.query(
    `insert into arbiter_sets (${COLUMNS})
     values ($1, $2, $3, $4)
     on conflict (chain_id, version) do update set
       arbiters = excluded.arbiters,
       threshold = excluded.threshold`,
    [set.chainId, set.version, set.arbiters.map(hexToBytes), set.threshold],
  );
}

export async function get(db: Database, chainId: number, version: number): Promise<ArbiterSetRecord | null> {
  const { rows } = await db.query<ArbiterSetRow>(`select ${COLUMNS} from arbiter_sets where chain_id = $1 and version = $2`, [chainId, version]);
  const row = rows[0];
  return row === undefined ? null : rowToArbiterSet(row);
}

export async function latest(db: Database, chainId: number): Promise<ArbiterSetRecord | null> {
  const { rows } = await db.query<ArbiterSetRow>(`select ${COLUMNS} from arbiter_sets where chain_id = $1 order by version desc limit 1`, [chainId]);
  const row = rows[0];
  return row === undefined ? null : rowToArbiterSet(row);
}
