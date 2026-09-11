drop index if exists x402_payments_reconcile;

alter table x402_payments drop column if exists last_checked_at;
