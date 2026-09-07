create table keeper_actions (
  id            bigserial     primary key,
  chain_id      bigint        not null,
  job_id        numeric(78,0) not null,
  action        text          not null,
  tx_hash       bytea,
  gas_used      bigint,
  fee_earned    numeric(20,0),
  reason        text,
  created_at    timestamptz   not null default now()
);
