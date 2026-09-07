import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, nullableBytesToHex, toBigInt, type Hex } from "../codec.js";

export const X402_STATUS = { accepted: 1, settled: 2, failed: 3 } as const;

export interface PaymentIdentity {
  chainId: number;
  asset: Hex;
  payer: Hex;
  nonce: Hex;
}

export interface AcceptedPayment extends PaymentIdentity {
  amount: bigint;
  payTo: Hex;
  resource: string;
  validBefore: bigint;
}

export interface X402PaymentRecord extends AcceptedPayment {
  txHash: Hex | null;
  status: number;
  createdAt: Date;
}

interface X402PaymentRow {
  chain_id: string;
  asset: Uint8Array;
  payer: Uint8Array;
  nonce: Uint8Array;
  amount: string;
  pay_to: Uint8Array;
  resource: string;
  tx_hash: Uint8Array | null;
  status: number;
  valid_before: string;
  created_at: Date;
}

const COLUMNS = "chain_id, asset, payer, nonce, amount, pay_to, resource, tx_hash, status, valid_before, created_at";
const IDENTITY_MATCH = "chain_id = $1 and asset = $2 and payer = $3 and nonce = $4";

function identityParams(identity: PaymentIdentity): unknown[] {
  return [identity.chainId, hexToBytes(identity.asset), hexToBytes(identity.payer), hexToBytes(identity.nonce)];
}

export async function insertAccepted(db: Database, payment: AcceptedPayment): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into x402_payments (chain_id, asset, payer, nonce, amount, pay_to, resource, status, valid_before)
     values ($1, $2, $3, $4, $5, $6, $7, ${X402_STATUS.accepted}, $8)
     on conflict (chain_id, asset, payer, nonce) do nothing`,
    [...identityParams(payment), payment.amount.toString(), hexToBytes(payment.payTo), payment.resource, payment.validBefore.toString()],
  );
  return rowCount === 1;
}

export async function markSettled(db: Database, identity: PaymentIdentity, txHash: Hex): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set status = ${X402_STATUS.settled}, tx_hash = $5
     where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    [...identityParams(identity), hexToBytes(txHash)],
  );
  return rowCount === 1;
}

export async function markFailed(db: Database, identity: PaymentIdentity, txHash?: Hex): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set status = ${X402_STATUS.failed}, tx_hash = coalesce($5::bytea, tx_hash)
     where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    [...identityParams(identity), txHash === undefined ? null : hexToBytes(txHash)],
  );
  return rowCount === 1;
}

export async function get(db: Database, identity: PaymentIdentity): Promise<X402PaymentRecord | null> {
  const { rows } = await db.query<X402PaymentRow>(`select ${COLUMNS} from x402_payments where ${IDENTITY_MATCH}`, identityParams(identity));
  const row = rows[0];
  return row === undefined
    ? null
    : {
        chainId: Number(row.chain_id),
        asset: bytesToHex(row.asset),
        payer: bytesToHex(row.payer),
        nonce: bytesToHex(row.nonce),
        amount: toBigInt(row.amount),
        payTo: bytesToHex(row.pay_to),
        resource: row.resource,
        txHash: nullableBytesToHex(row.tx_hash),
        status: row.status,
        validBefore: toBigInt(row.valid_before),
        createdAt: row.created_at,
      };
}

export async function sweep(db: Database): Promise<number> {
  const { rowCount } = await db.query("delete from x402_payments where to_timestamp(valid_before) + interval '30 days' <= now()");
  return rowCount;
}
