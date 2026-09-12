delete from x402_payments
where valid_before > extract(epoch from timestamptz '294276-12-31 23:59:59+00' - interval '30 days');

create index x402_payments_expiry on x402_payments (valid_before);
