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
  reason: string | null;
  createdAt: Date;
}

export interface AcceptedSettlement extends PaymentIdentity {
  txHash: Hex | null;
  validBefore: bigint;
}

export interface FailureDetail {
  reason?: string | undefined;
  txHash?: Hex | undefined;
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
  reason: string | null;
  created_at: Date;
}

interface AcceptedSettlementRow {
  chain_id: string;
  asset: Uint8Array;
  payer: Uint8Array;
  nonce: Uint8Array;
  tx_hash: Uint8Array | null;
  valid_before: string;
}

const COLUMNS = "chain_id, asset, payer, nonce, amount, pay_to, resource, tx_hash, status, valid_before, reason, created_at";
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

export async function markSettled(db: Database, identity: PaymentIdentity, txHash: Hex | null, reason?: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set status = ${X402_STATUS.settled}, tx_hash = coalesce($5::bytea, tx_hash), reason = coalesce($6, reason)
     where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    [...identityParams(identity), txHash === null ? null : hexToBytes(txHash), reason ?? null],
  );
  return rowCount === 1;
}

export async function markFailed(db: Database, identity: PaymentIdentity, failure: FailureDetail = {}): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set status = ${X402_STATUS.failed}, tx_hash = coalesce($5::bytea, tx_hash), reason = $6
     where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    [
      ...identityParams(identity),
      failure.txHash === undefined ? null : hexToBytes(failure.txHash),
      failure.reason ?? null,
    ],
  );
  return rowCount === 1;
}

export async function markChecked(db: Database, identity: PaymentIdentity): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set last_checked_at = now() where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    identityParams(identity),
  );
  return rowCount === 1;
}

export async function recordSettlementAttempt(db: Database, identity: PaymentIdentity, txHash: Hex): Promise<boolean> {
  const { rowCount } = await db.query(
    `update x402_payments set tx_hash = $5 where ${IDENTITY_MATCH} and status = ${X402_STATUS.accepted}`,
    [...identityParams(identity), hexToBytes(txHash)],
  );
  return rowCount === 1;
}

export async function listAccepted(db: Database, limit = 100): Promise<AcceptedSettlement[]> {
  const { rows } = await db.query<AcceptedSettlementRow>(
    `select chain_id, asset, payer, nonce, tx_hash, valid_before from x402_payments
     where status = ${X402_STATUS.accepted}
     order by last_checked_at asc nulls first, created_at, payer, nonce limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    chainId: Number(row.chain_id),
    asset: bytesToHex(row.asset),
    payer: bytesToHex(row.payer),
    nonce: bytesToHex(row.nonce),
    txHash: nullableBytesToHex(row.tx_hash),
    validBefore: toBigInt(row.valid_before),
  }));
}

export async function exists(db: Database, identity: PaymentIdentity): Promise<boolean> {
  const { rows } = await db.query(`select 1 from x402_payments where ${IDENTITY_MATCH} limit 1`, identityParams(identity));
  return rows.length > 0;
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
        reason: row.reason,
        createdAt: row.created_at,
      };
}

export async function sweep(db: Database): Promise<number> {
  const { rowCount } = await db.query(
    "delete from x402_payments where valid_before <= extract(epoch from now() - interval '30 days')",
  );
  return rowCount;
}
