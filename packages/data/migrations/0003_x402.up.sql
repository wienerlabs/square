create table x402_payments (
  chain_id      bigint        not null,
  asset         bytea         not null,
  payer         bytea         not null,
  nonce         bytea         not null,
  amount        numeric(20,0) not null,
  pay_to        bytea         not null,
  resource      text          not null,
  tx_hash       bytea,
  status        smallint      not null,
  valid_before  bigint        not null,
  created_at    timestamptz   not null default now(),
  primary key (chain_id, asset, payer, nonce)
);
