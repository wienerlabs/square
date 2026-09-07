import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, nullableBytesToHex, nullableHexToBytes, toBigInt, type Hex } from "../codec.js";

export const CLAIM_LISTING_STATUS = { listed: 1, sold: 2, cancelled: 3 } as const;

export interface ClaimListingRecord {
  chainId: number;
  jobId: bigint;
  seller: Hex;
  buyer: Hex | null;
  price: bigint;
  faceValue: bigint;
  status: number;
  updatedBlock: bigint;
}

interface ClaimListingRow {
  chain_id: string;
  job_id: string;
  seller: Uint8Array;
  buyer: Uint8Array | null;
  price: string;
  face_value: string;
  status: number;
  updated_block: string;
}

const COLUMNS = "chain_id, job_id, seller, buyer, price, face_value, status, updated_block";

function rowToListing(row: ClaimListingRow): ClaimListingRecord {
  return {
    chainId: Number(row.chain_id),
    jobId: toBigInt(row.job_id),
    seller: bytesToHex(row.seller),
    buyer: nullableBytesToHex(row.buyer),
    price: toBigInt(row.price),
    faceValue: toBigInt(row.face_value),
    status: row.status,
    updatedBlock: toBigInt(row.updated_block),
  };
}

export async function upsert(db: Database, listing: ClaimListingRecord): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into claim_listings (${COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chain_id, job_id) do update set
       seller = excluded.seller,
       buyer = excluded.buyer,
       price = excluded.price,
       face_value = excluded.face_value,
       status = excluded.status,
       updated_block = excluded.updated_block
     where claim_listings.updated_block <= excluded.updated_block`,
    [
      listing.chainId,
      listing.jobId.toString(),
      hexToBytes(listing.seller),
      nullableHexToBytes(listing.buyer),
      listing.price.toString(),
      listing.faceValue.toString(),
      listing.status,
      listing.updatedBlock.toString(),
    ],
  );
  return rowCount === 1;
}

export async function get(db: Database, chainId: number, jobId: bigint): Promise<ClaimListingRecord | null> {
  const { rows } = await db.query<ClaimListingRow>(`select ${COLUMNS} from claim_listings where chain_id = $1 and job_id = $2`, [
    chainId,
    jobId.toString(),
  ]);
  const row = rows[0];
  return row === undefined ? null : rowToListing(row);
}

export async function listListed(db: Database, chainId: number): Promise<ClaimListingRecord[]> {
  const { rows } = await db.query<ClaimListingRow>(
    `select ${COLUMNS} from claim_listings where chain_id = $1 and status = ${CLAIM_LISTING_STATUS.listed} order by job_id`,
    [chainId],
  );
  return rows.map(rowToListing);
}
