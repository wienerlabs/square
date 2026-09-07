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
one when given `{ dataDir }`. Inside `transaction`, issue every query through `tx`; nested
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
| `idempotencyKeys` | `get`, `putIfAbsent` (returns `stored`, `replay` or `conflict`), `sweepExpired` |
| `rateLimits` | `increment(db, bucket, windowStart)` (returns the new count), `sweep(db, windowMs)` |
| `x402Payments` | `insertAccepted` (false on replay), `markSettled`, `markFailed`, `get`, `sweep` |
| `keeperActions` | `append`, `recent` |
| `hostedAgents` | `upsert`, `get` |

Mirror upserts (`jobs`, `disputes`, `claimListings`) only write when the incoming
`updatedBlock` is at or after the stored one and return whether they wrote, so a replay of
old blocks cannot regress a row.

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

## Migrations

Migrations are numbered pairs of plain SQL files under `migrations/`:
`NNNN_name.up.sql` and `NNNN_name.down.sql`. Every migration must have a down file; the
runner refuses a directory where one is missing. Applied migrations are recorded in
`schema_migrations (name text primary key, applied_at timestamptz)`, each inside its own
transaction.

| Migration | Tables |
|---|---|
| `0001_indexer` | `indexer_checkpoints`, `job_events`, `jobs`, `disputes`, `claim_listings`, `ledger_balances`, `arbiter_sets` |
| `0002_hardening` | `idempotency_keys`, `rate_limits` |
| `0003_x402` | `x402_payments` |
| `0004_hosted_agents` | `hosted_agents` |
| `0005_keeper` | `keeper_actions` |

Migrations never run at service boot. They are an explicit deploy step, run before the new
service version starts, with the connection string in `DATABASE_URL`:

```sh
square-data migrate status
square-data migrate up
square-data migrate down        # reverts the last migration
square-data migrate down 3      # reverts the last three
```

Programmatically:

```ts
await migrate(db, MIGRATIONS_DIR, "up");
await migrate(db, MIGRATIONS_DIR, "down", 2);
const { applied, pending } = await migrationStatus(db, MIGRATIONS_DIR);
```

The test suite applies up, down and up again on PGlite and checks that the schema comes
back identical, so every migration is exercised on every run without a daemon.

## Retention

Sweeps encode the retention table from the design document: `idempotencyKeys.sweepExpired`
removes keys 24 hours after `expires_at`, `rateLimits.sweep(db, windowMs)` keeps two
windows, `x402Payments.sweep` removes authorizations 30 days after `valid_before`. Mirror
tables and `job_events` are kept forever.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```
