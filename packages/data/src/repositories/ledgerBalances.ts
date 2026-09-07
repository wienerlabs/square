import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, toBigInt, type Hex } from "../codec.js";
import type { IndexedContract } from "../contracts.js";

export interface LedgerBalanceRecord {
  chainId: number;
  contract: IndexedContract;
  account: Hex;
  amount: bigint;
  updatedBlock: bigint;
}

export interface LedgerAdjustment {
  chainId: number;
  contract: IndexedContract;
  account: Hex;
  delta: bigint;
  updatedBlock: bigint;
}

interface LedgerBalanceRow {
  chain_id: string;
  contract: IndexedContract;
  account: Uint8Array;
  amount: string;
  updated_block: string;
}

export async function adjust(db: Database, adjustment: LedgerAdjustment): Promise<bigint> {
  const { rows } = await db.query<{ amount: string }>(
    `insert into ledger_balances (chain_id, contract, account, amount, updated_block)
     values ($1, $2, $3, $4, $5)
     on conflict (chain_id, contract, account) do update set
       amount = ledger_balances.amount + excluded.amount,
       updated_block = excluded.updated_block
     returning amount`,
    [adjustment.chainId, adjustment.contract, hexToBytes(adjustment.account), adjustment.delta.toString(), adjustment.updatedBlock.toString()],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("ledger adjustment returned no row");
  return toBigInt(row.amount);
}

export async function get(db: Database, chainId: number, contract: IndexedContract, account: Hex): Promise<LedgerBalanceRecord | null> {
  const { rows } = await db.query<LedgerBalanceRow>(
    "select chain_id, contract, account, amount, updated_block from ledger_balances where chain_id = $1 and contract = $2 and account = $3",
    [chainId, contract, hexToBytes(account)],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        chainId: Number(row.chain_id),
        contract: row.contract,
        account: bytesToHex(row.account),
        amount: toBigInt(row.amount),
        updatedBlock: toBigInt(row.updated_block),
      };
}
