# @squaresdk/data

The single Postgres access layer for Square, as decided in
[`docs/design/data-layer.md`](../../docs/design/data-layer.md). Raw SQL through `pg` for
services, PGlite (Postgres compiled to WASM, in process) behind the same interface for tests,
and plain SQL migrations applied by a small runner.

## The rule

**The chain is the source of truth. The database holds mirrors and derived data only.
No decision that moves money is made by reading the database.** Absence of a row never
grants anything: a missing idempotency row means "process the request", a missing rate-limit
row means "counter is zero", a missing job row means "ask the chain", never "skip the check".

The only tables the database is authoritative about are `x402_payments` and
`idempotency_keys`, and both are authoritative about our own server-side actions, never
about chain state.

## Interface

```ts
import { pgDatabase, pgliteDatabase, migrate, migrationStatus, MIGRATIONS_DIR, jobs } from "@squaresdk/data";

interface Database {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const db = pgDatabase(process.env.DATABASE_URL, { max: 10 });
const testDb = await pgliteDatabase();
```

`pgDatabase` wraps a `pg.Pool`. `pgliteDatabase` opens an in-memory PGlite, or a persistent
one when given `{ dataDir }`.

The pool always carries an `error` listener, because `pg` re-emits the failure of an idle
connection on the pool itself and an `error` event with no listener is an
`uncaughtException`: a healthy keeper sitting between ticks would die of a database
restart without reaching its own fatal log line. The listener swallows the event so the
next query takes a fresh connection, which is what the pool already does on its own, and
`onPoolError` is where a service says what to write:

```ts
const db = pgDatabase(process.env.DATABASE_URL, {
  onPoolError: (error) => logger.error("keeper.pool_error", { error: error.message }),
});
```

`pgDatabaseFromPool(pool, options)` is the same thing over a pool the caller built. Inside `transaction`, issue every query through `tx`; nested
`tx.transaction` calls become savepoints. A `Database` handed to a transaction callback
cannot be closed.

Repositories are plain functions over `Database` and are the only place SQL lives; a
service never imports `pg` directly:

| Module | Functions |
|---|---|
| `jobs` | `upsert`, `get`, `listOpen`, `listByProvider`, `listInChallengeWindow(db, chainId, now)` |
| `jobEvents` | `insertIfAbsent` (keyed by chain, block, log index; returns whether it inserted) |
| `checkpoints` | `get`, `set` |
| `disputes` | `upsert`, `get`, `listOpen` |
| `claimListings` | `upsert`, `get`, `listListed` |
| `ledgerBalances` | `adjust` (by delta, returns the new amount), `get` |
| `arbiterSets` | `upsert`, `get`, `latest` |
| `idempotencyKeys` | `get`, `putIfAbsent` (takes `ttlMs`, returns `stored`, `replay` or `conflict`), `sweepExpired` |
| `rateLimits` | `increment(db, bucket, windowStart)` (returns the new count), `sweep(db, windowMs)` |
| `x402Payments` | `insertAccepted` (false on replay), `markSettled`, `markFailed`, `recordSettlementAttempt`, `listAccepted`, `exists`, `get`, `sweep` |
| `keeperActions` | `append`, `recent`, `sweep` |
| `hostedAgents` | `upsert`, `get` |

Mirror upserts (`jobs`, `disputes`, `claimListings`) only write when the incoming
`updatedBlock` is at or after the stored one and return whether they wrote, so a replay of
old blocks cannot regress a row.

`idempotencyKeys` is the only implementation of the `idempotency_keys` table; `@squaresdk/hardening`
exports the HTTP shape (`postgresIdempotencyStore`, `withIdempotency`, `idempotencyMiddleware`) and
delegates every statement here, the way `@squaresdk/x402` delegates its replay ledger to
`x402Payments`. `putIfAbsent` takes a `ttlMs` and writes `expires_at` as
`now() + ($n::double precision * interval '1 millisecond')`, so the expiry is written on the same
clock that `where expires_at <= now()` reads it back on and a caller whose own clock has drifted
still gets the lifetime it asked for. When the claim is lost and the row has expired again before it
can be read, `putIfAbsent` retries `CLAIM_ATTEMPTS` times and then throws rather than recursing
without a bound.

### Type boundary

| Postgres | TypeScript |
|---|---|
| `bytea` (addresses, hashes, nonces, deliverables) | lowercase `0x`-prefixed hex string (`Hex`) |
| `numeric(78,0)`, `numeric(20,0)`, `bigint` (ids, amounts, block numbers, unix timestamps) | `bigint` |
| `chain_id` | `number` |
| `smallint`, `integer` (status codes, basis points, counts) | `number` |
| `timestamptz` | `Date` |
| `jsonb` | `Json` |

Status legends carried in code: `jobs.JOB_STATUS` (ERC-8183 order: open 0, funded 1,
submitted 2, completed 3, rejected 4, expired 5), `disputes.DISPUTE_OUTCOME` (complete 1,
reject 2, expired 3), `claimListings.CLAIM_LISTING_STATUS` (listed 1, sold 2, cancelled 3),
`x402Payments.X402_STATUS` (accepted 1, settled 2, failed 3). Indexed contracts are the
`IndexedContract` union; keeper actions are the `KeeperAction` union.

`x402_payments` has one transition rule and this repository is the only implementation of
it: `accepted` is the only state a row can leave, `settled` and `failed` are terminal, and
`markSettled` and `markFailed` return whether the update held so a caller can tell a real
transition from a zero-row update. `markFailed` stores its reason, and the transaction
hash when the failure carries one; a failure with no hash leaves the column as it was.
`recordSettlementAttempt` records a broadcast transaction hash without leaving `accepted`,
and `listAccepted` returns the rows that have not reached a terminal state, which is what
`@squaresdk/x402`'s reconciliation pass reads.

## Migrations

Migrations are numbered pairs of plain SQL files under `migrations/`:
`NNNN_name.up.sql` and `NNNN_name.down.sql`. Every migration must have a down file; the
runner refuses a directory where one is missing. Applied migrations are recorded in
`schema_migrations (name text primary key, applied_at timestamptz)`, each inside its own
transaction.

**These migrations are the only definition of these tables.** No package ships a
`create table` for a table that lives here, and nothing creates one at boot. Every table
below is created by `square-data migrate up` and by nothing else, so there is one place
to read to know what a column holds.

A table that exists before its migration runs stops the chain: the migration fails, its
transaction rolls back, its name is never written to `schema_migrations`, and every later
migration stays unapplied. The runner turns that into a `MigrationConflictError` naming
the migration, the object, and the two ways out (drop the object, or record the migration
as applied with `insert into schema_migrations (name) values ('NNNN_name')`), rather than
letting a raw `relation already exists` stall the deploy.

That error is for an object something outside the runner created. Two runners started at
once are not that case, and they do not raise it. Each migration runs in its own
transaction that first takes `lock table schema_migrations in access exclusive mode`, so
the second runner waits; when it gets the lock it re-reads `schema_migrations` for the
migration it is about to apply and, if the first runner recorded it in the meantime,
skips it and moves on. Both runners return, the migration is applied once, and only the
runner that actually applied it lists the name in `applied`. Deploy pipelines that can
fire the same step twice, or roll out two regions in parallel, need no coordination
beyond the database.

| Migration | Tables |
|---|---|
| `0001_indexer` | `indexer_checkpoints`, `job_events`, `jobs`, `disputes`, `claim_listings`, `ledger_balances`, `arbiter_sets` |
| `0002_hardening` | `idempotency_keys`, `rate_limits` |
| `0003_x402` | `x402_payments` |
| `0004_hosted_agents` | `hosted_agents` |
| `0005_keeper` | `keeper_actions` |
| `0006_x402_reason` | `x402_payments.reason` |
| `0007_refund_reason_and_expiry_sweep` | `jobs.refund_reason` |
| `0008_keeper_give_up` | `keeper_actions.gave_up` |
| `0009_x402_last_checked` | `x402_payments.last_checked_at` |
| `0010_quarantined_events` | `quarantined_events` |
| `0011_x402_valid_before_repair` | `x402_payments.valid_before` rows and index |

Migrations never run at service boot against a configured database. They are an explicit
deploy step, run before the new service version starts, with the connection string in
`DATABASE_URL`:

```sh
square-data migrate status
square-data migrate up
square-data migrate down        # reverts the last migration
square-data migrate down 3      # reverts the last three
square-data sweep               # runs every retention sweep once
square-data sweep 60000         # same, with the rate limiter's windowMs
```

Programmatically:

```ts
await migrate(db, MIGRATIONS_DIR, "up");
await migrate(db, MIGRATIONS_DIR, "down", 2);
const { applied, pending } = await migrationStatus(db, MIGRATIONS_DIR);
```

The one exception is the mode with no database to preserve. Without `DATABASE_URL` the
indexer and the keeper fall back to an ephemeral in-process PGlite, and each migrates that
itself on start (`services/indexer/src/main.ts`, `services/keeper/src/main.ts`), logging
that it did. That database dies with the process, so there is nothing a boot-time migration
could damage; a configured Postgres is never touched at boot.

The test suite applies up, down and up again on PGlite and checks that the schema comes
back identical, so every migration is exercised on every run without a daemon.

`0010_x402_valid_before_repair` is the one migration that also touches rows. `valid_before`
is a client-signed integer, and the sweep used to read it with `to_timestamp(valid_before)
+ interval '30 days'`, an expression that raises `timestamp out of range` from
`9224315424000` up. A single row in that range made the sweep throw on every run, which
took `keeper_actions` down with it because the sweeps ran in one chain. The sweep no longer
calls `to_timestamp`, so it can no longer overflow, but it also cannot delete a deadline
that far out, so this migration removes exactly the rows the old expression could not
evaluate, and indexes `valid_before` for the comparison that replaced it. The delete has
no inverse; the down script drops the index.

## Retention

Sweeps encode the retention table from the design document: `idempotencyKeys.sweepExpired`
removes keys 24 hours after `expires_at`, `rateLimits.sweep(db, windowMs)` keeps two
windows, `x402Payments.sweep` removes authorizations 30 days after `valid_before`, and
`keeperActions.sweep` removes journal rows older than 90 days. Mirror tables and
`job_events` are kept forever.

`square-data sweep` runs all four in one pass and prints the row count each removed, and
`sweepAll(db, { rateLimitWindowMs })` is the same thing in process. The four are
independent, so one failing no longer cancels the rest: `sweepAll` returns
`{ removed, failures }`, runs every sweep whatever the ones before it did, and names the
table and the message of each one that threw. `square-data sweep` prints the counts,
prints each failure on stderr, and exits 1 when there is one. Nothing schedules
itself: a sweep runs because an operator scheduled it, on the same host and with the same
`DATABASE_URL` as the migration step. Hourly, as the design document says, is one cron
line:

```cron
17 * * * * DATABASE_URL=postgres://... /usr/local/bin/square-data sweep 60000 >> /var/log/square-data-sweep.log 2>&1
```

or a systemd timer beside the service:

```ini
# /etc/systemd/system/square-data-sweep.service
[Service]
Type=oneshot
Environment=DATABASE_URL=postgres://...
ExecStart=/usr/local/bin/square-data sweep 60000

# /etc/systemd/system/square-data-sweep.timer
[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

The argument is the rate limiter's `windowMs`: the sweep keeps two windows, so it has to
be told how long one is. It defaults to 60000.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```
