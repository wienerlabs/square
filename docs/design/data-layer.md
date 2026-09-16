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
  refund_reason     text,                              -- null for a plain expiry; 'payoutUnresolvable' when the resolver could not answer
  updated_block     bigint        not null,
  primary key (chain_id, job_id)
);
create index jobs_open               on jobs (chain_id, status) where status in (0, 1);
create index jobs_by_provider        on jobs (chain_id, provider);
create index jobs_in_window          on jobs (chain_id, challenge_end) where status = 2 and not disputed;
create index jobs_expired_with_agent on jobs (chain_id, job_id) where status = 5 and agent_id is not null;

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

create table quarantined_events (            -- the logs that reached neither the journal nor the mirror
  chain_id      bigint      not null,
  block_number  bigint      not null,
  log_index     integer     not null,
  tx_hash       bytea       not null,
  contract      text        not null,
  event_name    text        not null,
  stage         text        not null,     -- 'journal' | 'reduce', the step that refused the log
  error         text        not null,     -- the failure, truncated to 500 characters
  created_at    timestamptz not null default now(),
  primary key (chain_id, block_number, log_index)
);
create index quarantined_events_recent on quarantined_events (chain_id, block_number desc, log_index desc);
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

`quarantined_events` is where that set-aside log is written, in the same
transaction that advances the checkpoint, and it is a table rather than a list
in memory because of the `journal` stage. A log the reducer rejected is still in
`job_events` and comes back through the replay on the next start; a log Postgres
refused is in no table at all and its block range is never read again, so before
this table existed it vanished on restart and `/quarantine` came up empty with
the event still missing from the mirror. The primary key is the same chain
position `job_events` uses, so the same log recorded twice updates one row
instead of adding a second. `quarantined_events_recent` is the index
`/quarantine` reads, which answers with the hundred most recent rows of a chain.
Like the other derived tables it is deleted for that chain when
`ON_DEPLOYMENT_CHANGE=restart` reindexes, because a log of the previous
deployment explains nothing about the current one.

### One deployment at a time, and the larger shape that would hold two

Every mirror row is keyed by `(chain_id, job_id)` and nothing in it says which
`SquareJob` issued that id, so two deployments on the same chain collide by
construction: after a redeploy the earlier deployment's jobs sit in `jobs`,
`disputes`, `claim_listings` and the ledgers and the read surface serves them as
current until the new deployment happens to reuse the same ids. The fix in place
is deletion: `ON_DEPLOYMENT_CHANGE=restart` removes that chain's derived rows in
the same transaction before it reindexes, so one deployment is mirrored at a
time. The larger option is to put the deployment in the key, either as a
`deployment` column carrying the `SquareJob` address (or a short id resolved
from `indexer_checkpoints`) in the primary key of every mirror table and in the
journal, or as one schema per deployment. It would let two deployments live side
by side, make a redeploy non-destructive, and let the app show the old stack's
history next to the new one. It is deferred because it touches the key of every
mirror table, every repository signature and every read route at once, for a
benefit no consumer asks for today: the app reads one deployment, the keeper
acts on one deployment, and a testnet redeploy that drops the earlier mirror
loses nothing that `job_events` on an archived database does not still hold.
When mainnet history has to survive a redeploy, this is the change to make, and
the deletion above becomes its migration path.

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
  chain_id        bigint      not null,
  asset           bytea       not null,      -- token address
  payer           bytea       not null,      -- authorization.from
  nonce           bytea       not null,      -- authorization.nonce, 32 bytes
  amount          numeric(20,0) not null,
  pay_to          bytea       not null,
  resource        text        not null,
  tx_hash         bytea,                     -- set at settlement
  status          smallint    not null,      -- 1 accepted, 2 settled, 3 failed
  valid_before    bigint      not null,
  reason          text,                      -- why the row left 'accepted', on either terminal status
  last_checked_at timestamptz,               -- when reconciliation last looked at an accepted row and could not close it
  created_at      timestamptz not null default now(),
  primary key (chain_id, asset, payer, nonce)
);
create index x402_payments_reconcile on x402_payments (last_checked_at asc nulls first, created_at, payer, nonce) where status = 1;
create index x402_payments_expiry    on x402_payments (valid_before);
```

The primary key is the EIP-3009 authorization identity. Inserting it *before*
settlement, inside the verify step, is the replay guard: a second request
carrying the same signed authorization hits the constraint and is refused before
any chain call. The chain enforces the same uniqueness (`authorizationState`)
and we still keep ours, because the chain's check happens at settlement and the
resource has already been served by then.

`reason` carries why a row left `accepted`, which is the settlement failure on a
`failed` row and, on a `settled` one, the note a settle that reported no
transaction hash leaves behind. `last_checked_at` is what keeps the
reconciliation queue moving: `listAccepted` orders by `last_checked_at asc nulls
first`, so a row no pass has examined always sorts ahead of one a pass already
examined and left open. Without it the rows nobody could close stayed at the head
of the queue and nothing newer was ever looked at again.
`x402_payments_reconcile` is that ordering's index and it covers `accepted` rows
only, because a terminal row is never queued.

`valid_before` is an unvalidated integer out of a client-signed payload, not a
deadline this service chose, and the retention sweep used to read it through
`to_timestamp`, which raises `timestamp out of range` on a large enough value. A
single such row made the sweep throw on every run, and while the four sweeps
still ran in one chain it took `keeper_actions` down with it.
`0011_x402_valid_before_repair` deleted exactly the rows the old expression could
not evaluate, those past
`extract(epoch from timestamptz '294276-12-31 23:59:59+00' - interval '30 days')`,
and added `x402_payments_expiry` for the comparison that replaced it. The delete
has no inverse and the down file drops only the index. It was safe to run because
the same change closed the door the rows came through: an authorization whose
`validBefore` is past `now + maxTimeoutSeconds` plus five minutes of clock skew
is refused with `invalid_valid_before` before it is ever inserted.

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

### Keeper journal and keeper state (#42, #306)

```sql
create table keeper_actions (                -- append-only, one row per thing the keeper did
  id            bigserial   primary key,
  chain_id      bigint      not null,
  job_id        numeric(78,0) not null,
  action        text        not null,      -- 'finalize' | 'finalizeDecided' | 'lapse' | 'settleBond' | 'recordExpiry' | 'skipped'
  tx_hash       bytea,
  gas_used      bigint,
  fee_earned    numeric(20,0),
  reason        text,                      -- for 'skipped': 'unprofitable' | 'disputed' | …
  gave_up       boolean     not null default false,
  created_at    timestamptz not null default now()
);
create index keeper_actions_by_job  on keeper_actions (chain_id, job_id, action);
create index keeper_actions_gave_up on keeper_actions (chain_id, job_id) where gave_up;

create table keeper_job_state (              -- what the keeper has to still know after the journal is swept
  chain_id            bigint        not null,
  job_id              numeric(78,0) not null,
  finalize_gave_up    boolean       not null default false,
  expiry_recorded_at  timestamptz,           -- set once the expiry is on chain, whoever recorded it
  expiry_attempts     integer       not null default 0,
  expiry_next_at      bigint,                -- unix seconds, the earliest the sweep may try again
  expiry_gave_up      boolean       not null default false,
  unprofitable_journaled_at timestamptz,     -- set once, by whichever keeper first journaled the job as unprofitable (0013)
  held_reason         text,                  -- why the keeper is waiting rather than cranking: noProof or proofStale (0014)
  held_since          bigint,                -- unix seconds, when this reason started, for the grace
  updated_at          timestamptz   not null default now(),
  primary key (chain_id, job_id)
);
create index keeper_job_state_expiry_open on keeper_job_state (chain_id, expiry_next_at)
  where expiry_recorded_at is null and not expiry_gave_up;
create index keeper_job_state_held on keeper_job_state (chain_id, held_reason)
  where held_reason is not null;
```

The `action` list is the `KeeperAction` union in
`packages/data/src/repositories/keeperActions.ts`, and it is six values because
the keeper sends more than the two settlements: `lapse` closes a job whose
arbitration ran out of time and `settleBond` returns a disputer's bond on a job
that expired under its dispute, both of which earn no fee and are journaled all
the same.

The two tables are apart on purpose, and #306 is why. `keeper_actions` is the
journal, and `square-data sweep` deletes rows older than ninety days without
reading them. `keeper_job_state` is the state the keeper still has to be right
about after that sweep, so nothing sweeps it. While the give-up flag and the
expiry mark lived on journal rows, a ninety day old expiry re-entered the sweep's
candidate set at the head of the queue and a restarted keeper attacked every
given-up job from zero. `0012_keeper_job_state` seeds the new table from the
journal rows it replaces, one row per job that had a give-up and one per job
whose expiry was already recorded, so the upgrade forgets nothing.

`finalize_gave_up` is read back before the keeper's first tick, so a job it gave
up on stays given up across a restart until an operator clears the flag. The
three expiry columns carry the sweep's retry policy: `jobs.listExpiredWithAgent`
left-joins this table and returns an expired job only while `expiry_recorded_at`
is null, `expiry_gave_up` is false and `expiry_next_at` has passed, ordered by
how long the job has waited, and `keeper_job_state_expiry_open` is the partial
index that query reads. A `recordExpiry` journal row with no `reason` means the
expiry is recorded on chain: it carries the transaction hash when this keeper
sent it, and no hash when the keeper found it already recorded. Both cases also
set `expiry_recorded_at`, and it is that mark, not the journal row, that keeps
the job out of the next pass.

`held_reason` and `held_since` are a hold rather than a failure (0014). A held
job is one the keeper found a reason not to crank this tick, and the difference
from a failed attempt is that it costs no retry, burns no backoff and writes no
journal row: the next tick looks again. There are two reasons and they end
differently. `proofStale` means the module would refuse a proof it can read,
which is the mandate's own decision, so after `PROOF_GRACE_SECONDS` the job is
cranked anyway and the refusal is recorded on chain. `noProof` means there is
nothing to read at all, and since #382 the evaluator reverts `ProofRequired`
rather than settle such a job, so it has no grace: only the client, who alone
can bind a proof, ends that hold. `held_since` is when the current reason
started, not when the job was first held, so a job that moves from one reason to
the other starts its grace again. The partial index is what `/status` and
`/health` count, and a hold is released the moment the job leaves the mirror so
those counts cannot drift.

`unprofitable_journaled_at` is the "journaled once" of an unprofitable job, and
it is here rather than in memory so that "once" means once ever (#331): the
keeper claims it with a conditional upsert (`markUnprofitableJournaled`), the
first caller writes the `skipped` journal row and every later one, in this
process or the next, writes nothing. `0013_keeper_unprofitable_journal` adds the
column and backfills it from the `skipped` rows that already exist, and because
no sweep touches this table the mark outlives the ninety day journal it guards.

`gave_up` on a journal row records that the give-up happened and is shown on the
keeper's `/actions`. Since 0012 moved the flag itself, no statement in
`packages/data` filters on that column or on `(chain_id, job_id, action)`: the
journal is read only as the most recent rows of a chain, so neither
`keeper_actions_gave_up` nor `keeper_actions_by_job` serves a query today.

## Retention

| Table | Kept for | Because |
|---|---|---|
| `job_events` | forever | it is the audit trail and the replay source |
| `jobs`, `disputes`, `claim_listings`, `ledger_balances`, `arbiter_sets` | forever, rebuildable | mirror |
| `idempotency_keys` | 24 h after `expires_at` | a client retrying after a day is a new request |
| `rate_limits` | 2 windows | |
| `x402_payments` | `valid_before` + 30 days | after `validBefore` the authorization cannot be settled on chain anyway; 30 days covers reconciliation |
| `keeper_actions` | 90 days | operational, feeds the metrics in #50 |
| `keeper_job_state` | forever, never swept | it is state and not history: a ninety day old give-up is still a give-up, and a ninety day old expiry mark still keeps its job out of the sweep |
| `quarantined_events` | forever, rebuildable | it is the only record of a log that reached no other table, and a redeploy deletes it with the other derived rows |

The four tables with a finite retention are removed by `square-data sweep`, which runs
every sweep once and prints what each removed. The four are independent: a sweep that
throws is reported by table and message, and the ones after it still run, so one unsweepable row cannot stop the
retention of every other table. Nothing sweeps on its own: the operator schedules that
command hourly, from cron or a systemd timer, on the host that already holds
`DATABASE_URL` for the migration step. `packages/data/README.md` carries both schedule
examples.

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
and are the only place SQL lives. A service never imports `pg` directly, and a
package that owns an HTTP shape over one of these tables owns the shape only:
`@squaresdk/hardening` delegates `idempotency_keys` to `idempotencyKeys` and
`@squaresdk/x402` delegates its replay ledger to `x402Payments`, so each table
has exactly one set of statements.

A row's lifetime is measured on the database's clock, never on the caller's:
`idempotencyKeys.putIfAbsent` takes a TTL and computes `expires_at` in SQL, so
the side that writes the expiry and the side that decides it has passed cannot
disagree when a service's clock drifts.

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
