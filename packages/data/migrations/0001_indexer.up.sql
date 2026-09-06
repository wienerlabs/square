create table indexer_checkpoints (
  chain_id      bigint      not null,
  contract      text        not null,
  address       bytea       not null,
  last_block    bigint      not null,
  updated_at    timestamptz not null default now(),
  primary key (chain_id, contract)
);

create table job_events (
  chain_id      bigint  not null,
  block_number  bigint  not null,
  log_index     integer not null,
  tx_hash       bytea   not null,
  contract      text    not null,
  name          text    not null,
  job_id        numeric(78,0),
  args          jsonb   not null,
  primary key (chain_id, block_number, log_index)
);

create table jobs (
  chain_id          bigint        not null,
  job_id            numeric(78,0) not null,
  client            bytea         not null,
  provider          bytea,
  evaluator         bytea         not null,
  hook              bytea,
  description       text          not null default '',
  budget            numeric(20,0) not null default 0,
  status            smallint      not null,
  expired_at        bigint        not null,
  created_at        bigint        not null,
  funded_at         bigint,
  submitted_at      bigint,
  challenge_end     bigint,
  platform_fee_bp   integer,
  evaluator_fee_bp  integer,
  deliverable       bytea,
  payee             bytea,
  provider_bps      integer,
  reason            bytea,
  disputed          boolean       not null default false,
  agent_id          numeric(78,0),
  updated_block     bigint        not null,
  primary key (chain_id, job_id)
);
create index jobs_open        on jobs (chain_id, status) where status in (0, 1);
create index jobs_by_provider on jobs (chain_id, provider);
create index jobs_in_window   on jobs (chain_id, challenge_end) where status = 2 and not disputed;

create table disputes (
  chain_id      bigint        not null,
  job_id        numeric(78,0) not null,
  disputer      bytea         not null,
  bond          numeric(20,0) not null,
  disputed_at   bigint        not null,
  resolve_by    bigint        not null,
  set_version   integer       not null,
  outcome       smallint,
  provider_bps  integer,
  closed        boolean       not null default false,
  updated_block bigint        not null,
  primary key (chain_id, job_id)
);

create table claim_listings (
  chain_id      bigint        not null,
  job_id        numeric(78,0) not null,
  seller        bytea         not null,
  buyer         bytea,
  price         numeric(20,0) not null,
  face_value    numeric(20,0) not null,
  status        smallint      not null,
  updated_block bigint        not null,
  primary key (chain_id, job_id)
);

create table ledger_balances (
  chain_id      bigint        not null,
  contract      text          not null,
  account       bytea         not null,
  amount        numeric(20,0) not null default 0,
  updated_block bigint        not null,
  primary key (chain_id, contract, account)
);

create table arbiter_sets (
  chain_id   bigint   not null,
  version    integer  not null,
  arbiters   bytea[]  not null,
  threshold  smallint not null,
  primary key (chain_id, version)
);
