create table quarantined_events (
  chain_id      bigint        not null,
  block_number  bigint        not null,
  log_index     integer       not null,
  tx_hash       bytea         not null,
  contract      text          not null,
  event_name    text          not null,
  stage         text          not null,
  error         text          not null,
  created_at    timestamptz   not null default now(),
  primary key (chain_id, block_number, log_index)
);

create index quarantined_events_recent on quarantined_events (chain_id, block_number desc, log_index desc);
