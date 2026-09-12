alter table x402_payments add column last_checked_at timestamptz;

create index x402_payments_reconcile on x402_payments (last_checked_at asc nulls first, created_at, payer, nonce) where status = 1;
