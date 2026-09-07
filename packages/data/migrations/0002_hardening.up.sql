create table idempotency_keys (
  scope          text        not null,
  key            text        not null,
  request_hash   bytea       not null,
  status         smallint    not null,
  response       jsonb       not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  primary key (scope, key)
);
create index idempotency_expiry on idempotency_keys (expires_at);

create table rate_limits (
  bucket        text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (bucket, window_start)
);
create index rate_limit_gc on rate_limits (window_start);
