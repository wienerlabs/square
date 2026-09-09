# Data layer: one Postgres, one access layer, the chain is the source of truth

**Status:** decided in [#48][i48]. Binds the security layer ([#44][i44]), the
x402 gateway ([#33][i33]), the hosted agent executor ([#38][i38]) and the indexer
([#24][i24]). Implemented by `packages/data` (`@squaresdk/data`).

[i24]: https://github.com/wienerlabs/square/issues/24
[i33]: https://github.com/wienerlabs/square/issues/33
[i38]: https://github.com/wienerlabs/square/issues/38
[i44]: https://github.com/wienerlabs/square/issues/44
[i48]: https://github.com/wienerlabs/square/issues/48

Four issues assume durable storage and none of them was building it. The three
source repositories each picked their own: Prisma on Neon, two raw Postgres
databases, and Supabase. Three stacks, no shared access layer, and one of them
kept escrow ownership in an in-process `Map` and skipped the ownership check
when the entry was missing. That last one is the failure this document exists
to make impossible.

## The rule

**The chain is the source of truth. The database holds mirrors and derived
data only. No decision that moves money is made by reading the database.**

Concretely:

- The keeper decides whether a job is finalizable by reading the kernel
  (`getJob`, `challengeEndsAt`, `disputes`), not the `jobs` table. The table
  tells it *which* jobs to look at; the chain tells it whether to act.
- The indexer's `jobs` table may be rebuilt from scratch at any time by
  replaying logs. It is a cache of the chain with a query surface, nothing more.
- The x402 replay ledger and the idempotency table are the two places the
  database is authoritative, and both are authoritative about *our own*
  server-side actions (which authorizations we already accepted, which requests
  we already answered), never about chain state.
- Absence of a row never grants anything. A missing idempotency row means
  "process the request", a missing rate-limit row means "counter is zero", a
  missing job row means "ask the chain" — never "skip the check".

Each of the four consuming issues carries this rule as a note; the table at the
end records where.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Database | One Postgres 16 | Every consumer needs transactions, unique constraints and `SELECT … FOR UPDATE`. Nothing needs a second engine. |
| Hosting | Neon (serverless Postgres) for the hosted services; plain Postgres in Docker for local | Branching per pull request and point-in-time restore come with it; WienerLog already runs on the same setup |
| Access layer | Raw SQL through `pg`, wrapped in one `Database` interface | Every query in this project is either an upsert keyed by chain identity or a windowed counter. An ORM would model those worse than SQL does, and `prisma db push --accept-data-loss` on every deploy is how covenant lost data. |
| Test database | PGlite (Postgres compiled to WASM, in-process) behind the same `Database` interface | Tests run the real Postgres dialect with no daemon and no Docker, so CI stays hermetic and the migrations are exercised on every run. |
| Migrations | Numbered pairs of plain SQL files, `NNNN_name.up.sql` / `NNNN_name.down.sql`, applied by a 100-line runner that records them in `schema_migrations` | Reviewable in a diff, reversible by construction, no code generation, no daemon. Every migration must have a `down` and the test suite applies up, down, up. |
| Deploy discipline | Migrations run as an explicit step (`square-data migrate up`) before the new service version starts; never at service boot, never with data-loss flags | A service that migrates on boot migrates on every replica at once and on every crash-loop restart |
| Retention | see the table below | |
| Backups | Neon PITR, 7 days on the free tier, 30 days on the paid one; plus a nightly `pg_dump` of the authoritative tables (`x402_payments`, `idempotency_keys`) to object storage | The mirror tables are reproducible from the chain; the authoritative ones are not |

## Schema

Every mirror table is keyed by `(chain_id, …)`. Testnet and mainnet share a
schema and never share a row.

### Indexer (#24)

```sql
create table indexer_checkpoints (
  chain_id      bigint      not null,
  contract      text        not null,     -- 'SquareJob' | 'KeeperEvaluator' | 'Arbitration' | 'ClaimMarket' | 'SquareHook'
  address       bytea       not null,
  last_block    bigint      not null,     -- last block fully applied
  updated_at    timestamptz not null default now(),
  primary key (chain_id, contract)
);

create table job_events (                 -- append-only, the replay journal
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
  budget            numeric(20,0) not null default 0,   -- 6-decimal base units, fits uint64
  status            smallint      not null,             -- ERC-8183 enum order
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
  outcome       smallint,                 -- null until decided; 1 complete, 2 reject, 3 expired
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
  status        smallint      not null,   -- 1 listed, 2 sold, 3 cancelled
  updated_block bigint        not null,
  primary key (chain_id, job_id)
);

create table ledger_balances (             -- mirror of SquareJob.withdrawable and Arbitration.withdrawable
  chain_id      bigint  not null,
  contract      text    not null,
  account       bytea   not null,
  amount        numeric(20,0) not null default 0,
  updated_block bigint  not null,
  primary key (chain_id, contract, account)
);

create table arbiter_sets (
  chain_id   bigint  not null,
  version    integer not null,
  arbiters   bytea[] not null,
  threshold  smallint not null,
  primary key (chain_id, version)
);
```

`job_events` is what makes restart safe: the primary key is the log's chain
position, so replaying a block twice inserts nothing and the reducer never sees
the same log twice. The reducer itself is not idempotent per event, `credit` adds
and `WindowsConfigured` appends, so the guard is the journal and not the reducer:
the indexer applies a batch to a copy of its in-memory state and adopts that copy
only after the transaction commits, so a rolled-back batch leaves nothing behind
to be applied a second time on the retry. `indexer_checkpoints.last_block`
advances only after every log of that block is in `job_events` and reduced,
inside one transaction. A single log that cannot be journalled or reduced is
rolled back to its own savepoint, counted in
`square_indexer_quarantined_events_total` and listed on the indexer's
`/quarantine`, and the rest of the batch still commits.

### Security layer (#44)

```sql
create table idempotency_keys (
  scope          text        not null,     -- route family, e.g. 'x402' or 'agent-api'
  key            text        not null,     -- client-supplied Idempotency-Key
  request_hash   bytea       not null,     -- sha256 of method + path + canonical body
  status         smallint    not null,     -- HTTP status of the stored response
  response       jsonb       not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  primary key (scope, key)
);
create index idempotency_expiry on idempotency_keys (expires_at);

create table rate_limits (
  bucket        text        not null,      -- e.g. 'ip:1.2.3.4' or 'actor:0xabc…'
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (bucket, window_start)
);
create index rate_limit_gc on rate_limits (window_start);
```

Idempotency: the same key with a different `request_hash` is a conflict (409),
never a replay. Rate limits are fixed windows in the database, incremented with
`insert … on conflict do update set count = count + 1 returning count`, so a
restart, a second replica, or a crash between two requests changes nothing.

### x402 replay ledger (#33)

```sql
create table x402_payments (
  chain_id      bigint      not null,
  asset         bytea       not null,      -- token address
  payer         bytea       not null,      -- authorization.from
  nonce         bytea       not null,      -- authorization.nonce, 32 bytes
  amount        numeric(20,0) not null,
  pay_to        bytea       not null,
  resource      text        not null,
  tx_hash       bytea,                     -- set at settlement
  status        smallint    not null,      -- 1 accepted, 2 settled, 3 failed
  valid_before  bigint      not null,
  created_at    timestamptz not null default now(),
  primary key (chain_id, asset, payer, nonce)
);
```

The primary key is the EIP-3009 authorization identity. Inserting it *before*
settlement, inside the verify step, is the replay guard: a second request
carrying the same signed authorization hits the constraint and is refused before
any chain call. The chain enforces the same uniqueness (`authorizationState`)
and we still keep ours, because the chain's check happens at settlement and the
resource has already been served by then.

### Hosted agents (#38, proposal for mehmethayirli)

```sql
create table hosted_agents (
  id            uuid        primary key,
  owner         bytea       not null,      -- controlling address
  agent_id      numeric(78,0),             -- ERC-8004 id once registered
  config        jsonb       not null,      -- provider, model, tools; no secrets
  secret_ref    text,                      -- reference into the secret store, never the key
  budget_limit  numeric(20,0) not null,    -- 6-decimal USDC, a *soft* cap
  budget_spent  numeric(20,0) not null default 0,
  state         text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

`budget_limit` is a scheduling limit for the executor, not the compliance
counter. The hard limit is the policy counter on chain (#26), and the executor
must treat a job the chain refuses as refused regardless of what this row says.
Encrypted provider keys do not live in this table; the row holds a reference
into whatever secret store #49 chooses.

### Keeper journal (#42)

```sql
create table keeper_actions (
  id            bigserial   primary key,
  chain_id      bigint      not null,
  job_id        numeric(78,0) not null,
  action        text        not null,      -- 'finalize' | 'finalizeDecided' | 'recordExpiry' | 'skipped'
  tx_hash       bytea,
  gas_used      bigint,
  fee_earned    numeric(20,0),
  reason        text,                      -- for 'skipped': 'unprofitable' | 'disputed' | …
  created_at    timestamptz not null default now()
);
```

## Retention

| Table | Kept for | Because |
|---|---|---|
| `job_events` | forever | it is the audit trail and the replay source |
| `jobs`, `disputes`, `claim_listings`, `ledger_balances`, `arbiter_sets` | forever, rebuildable | mirror |
| `idempotency_keys` | 24 h after `expires_at`, swept hourly | a client retrying after a day is a new request |
| `rate_limits` | 2 windows, swept hourly | |
| `x402_payments` | `valid_before` + 30 days | after `validBefore` the authorization cannot be settled on chain anyway; 30 days covers reconciliation |
| `keeper_actions` | 90 days | operational, feeds the metrics in #50 |

## Access layer

```ts
interface Database {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Two implementations, one interface: `pgDatabase(connectionString)` for
services, `pgliteDatabase()` for tests. Repositories (`jobs`, `idempotency`,
`rateLimits`, `x402Payments`, `keeperActions`) are functions over `Database`
and are the only place SQL lives. A service never imports `pg` directly.

## Notes carried to the consuming issues

| Issue | Note |
|---|---|
| #44 | idempotency and rate-limit tables are here; both are keyed so that a restart or a second replica cannot reset them |
| #33 | the replay ledger's primary key is the authorization identity and the insert happens before settlement |
| #38 | `budget_limit` is a soft scheduling cap; the policy counter on chain is the limit that counts |
| #24 | `job_events` is the journal, `indexer_checkpoints` the cursor, and both move in one transaction |

## What was considered and rejected

**Prisma.** It is what covenant had, and the migration story (`db push`) is
what went wrong. Its query builder buys nothing for a schema this small.

**Drizzle.** Better than Prisma on migrations, but still a second language for
the schema and a generator step. The whole schema is 200 lines of SQL a
reviewer can read.

**Supabase.** Adds auth, storage and realtime we do not use, and ties the
database to a hosting product. Postgres is the dependency; the host is a
deployment choice.

**SQLite for the keeper.** The keeper's journal is small, but a second engine
means a second set of backups, a second test fixture and a second migration
runner. One Postgres is the decision.
