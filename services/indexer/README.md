# Indexer

Rebuilds the state of every Square job from chain events into Postgres and
serves the query surface. Discovery on Solana used `getProgramAccounts`; on Arc
the contracts emit events and this service reads them. The state is rebuilt from
events only; the indexer never calls a view to fill a gap, and the test suite
proves it by comparing the rebuilt state with the chain field by field.

## How it works

- `reducer.ts` is a pure function from the event stream to state: jobs,
  disputes, listings, the two pull-payment ledgers, arbiter sets and the
  evaluator windows. It is what `docs/design/storage-and-events.md` specifies.
- `sync.ts` fetches logs for the five contracts, and for `ComplianceModule` when
  the deployment record names one, in block batches, journals
  every log in `job_events` keyed by `(chain_id, block_number, log_index)`,
  applies the ones it has not seen, persists the touched rows and advances the
  checkpoint, all in one transaction. On start it replays the journal from the
  database and continues from the checkpoint, so a restart re-reads nothing
  from the chain and never applies a log twice.
- A batch is reduced into a copy of the in-memory state, and the copy is adopted
  only after the transaction commits. A rolled-back batch therefore leaves the
  in-memory state and the persisted ledger cursor exactly where they were, and
  the retry applies each log once rather than twice.
- Each log is journalled inside its own savepoint. One log that Postgres refuses
  or that the reducer rejects is set aside instead of failing the batch: it is
  counted in `square_indexer_quarantined_events_total`, logged as
  `indexer.event_quarantined`, listed on `/quarantine`, and the rest of the batch
  still commits and the checkpoint still advances. Chain strings are untrusted,
  so a `U+0000` in a job description is stripped on the way into the mirror
  rather than left to poison a `jsonb` bind.
- A set-aside log is written to `quarantined_events` in the same transaction that
  advances the checkpoint, and `/quarantine` is that table read back, capped at
  the hundred most recent. Durability matters most for the `journal` stage: a log
  the reducer rejected is still in `job_events` and comes back through the replay
  on the next start, but a log Postgres refused is in no table at all and its
  block range is never read again, so before this it vanished on restart and the
  `quarantine` health check went green with the event still missing from the
  mirror.
- On start it compares the address stored in `indexer_checkpoints` with the
  address in the deployment file. A mismatch means the checkpoint belongs to an
  earlier deployment on the same chain and resuming from it would silently skip
  every event of the new contracts, so the indexer refuses to start unless
  `ON_DEPLOYMENT_CHANGE=restart` tells it to reindex from `START_BLOCK`. A
  contract the record names that no earlier run indexed, such as a compliance
  module added to the record of a running indexer, counts as a change too:
  resuming would skip every log it emitted before the checkpoint.
- `ON_DEPLOYMENT_CHANGE=restart` is destructive on purpose: before it reindexes
  it deletes every derived row of that chain (`jobs`, `disputes`,
  `claim_listings`, `ledger_balances`, `arbiter_sets`, `quarantined_events` and
  the `job_events` journal) in one transaction, and drops the in-memory state with them. Without
  that deletion the earlier deployment's jobs stayed in the mirror and
  `/jobs/open`, `/jobs/:id`, `/listings` and `/disputes/open` served them as
  current while `/status` counted only the rebuilt state, so one service
  answered two ways. Rows of another chain are untouched, and a job of the new
  deployment is written again from its own logs. The alternative that keeps both
  deployments side by side is a deployment-keyed row, recorded as deferred in
  `docs/design/data-layer.md`.
- A `ReleaseRefused` from the compliance module changes no mirror row, because
  what the verdict did to the money arrives as the kernel's `PayoutRouted`. It
  is journaled with its `statement` decoded, so a refusal and the
  `ReleaseVerified` that spent the same statement are one `job_events` query
  apart, and it is logged as `indexer.release_refused` with the reason and the
  statement, or with a note that the proof could not be read when the statement
  is zero (#250).
- No reorg handling. Arc has deterministic finality: a block is either final or
  absent, so `latest` is safe to index.
- `api.ts` serves the query surface tabled under [Endpoints](#endpoints). Every
  list is bounded: one `GET` answers with at most `limit` rows and the cursor
  for the rest, never with the whole table, and the counts the app polls are
  counted in the database instead of being derived from a list it downloads.
- Every answer carries `Access-Control-Allow-Origin` for an allowed origin, on
  the plain `GET` and not only on a preflight. The app reads this surface from
  the browser with `Accept: application/json`, which is a safelisted header, so
  there is no preflight to hook; and the app is a static export served from
  another origin with no proxy to fall back on, so without the header the
  browser drops an answer the indexer sent in full. `CORS_ORIGINS` is the list,
  comma separated. Localhost on any port is always allowed, so a production
  origin has to be given explicitly, as with the prover.
- `/health` marks the lag check critical, so an indexer more than
  `MAX_LAG_BLOCKS` behind the chain head answers 503 rather than 200 and a
  readiness probe takes it out of rotation. The check never subtracts a head
  nobody sampled: until the chain head and the indexed head are both known it
  reports that it has not measured yet, which stays healthy for
  `STARTUP_GRACE_MS` after start and fails afterwards, so a checkpointed restart
  reports what it knows instead of a negative lag. It also watches the age of
  the last successful sync, so a loop frozen on a dead RPC, where both heads
  stop moving together and the difference stays small, fails after
  `MAX_SYNC_AGE_MS`.
- Alerting runs in-process every `ALERT_INTERVAL_MS` with the `indexerLagging`
  and `hookWriteFailures` rules. Delivery failures are logged as
  `indexer.alert_dispatch_failed` and counted in
  `square_alert_dispatch_failures_total`, so a broken webhook is visible instead
  of silent.
- `SubmissionTimed` arriving while no `WindowsConfigured` has been seen is a
  configuration error, not a job with no window: it warns as
  `indexer.windows_missing` and shows up as `missingWindowEvents` on `/status`.

## Endpoints

| Endpoint | Answers | Parameters |
|---|---|---|
| `GET /status` | Chain id, the indexed head, the chain head and the in-memory counters | none |
| `GET /overview` | Everything `/status` carries, plus `counts.open`, `counts.inWindow` and `counts.finalizable` counted in the database | none |
| `GET /jobs/open` | The jobs that are open or funded | `limit`, `after` |
| `GET /jobs/in-window` | Submitted, undisputed jobs whose challenge window is still open | `limit`, `after` |
| `GET /jobs/finalizable` | Submitted, undisputed jobs whose challenge window has closed | `limit`, `after` |
| `GET /jobs/provider/:address` | The jobs of one provider | `limit`, `after` |
| `GET /jobs/:id` | One job with its listing and its dispute | none |
| `GET /listings` | The claim listings still on sale | `limit`, `after` |
| `GET /disputes/open` | The disputes that are not closed | `limit`, `after` |
| `GET /quarantine` | The hundred most recent set-aside events | none |
| `GET /health`, `GET /metrics`, `GET /version` | The observability surface | none |

`limit` is the most rows one answer may carry: a whole number from 1 to 500,
100 when it is absent, and anything above 500 is read as 500. `after` is a job
id and the page starts at the first row whose `job_id` is greater, so a paged
answer is an object rather than an array:

```json
{ "items": [ ... ], "nextAfter": "142" }
```

`nextAfter` is the id to send as the next `after`, and `null` when the list ends
there, so a reader walks a list by following it until it is null. A `limit` that
is not a positive whole number and an `after` that is not a job id are both
answered 400.

A paged list is ordered by job id, because the cursor is a job id. The unpaged
reads keep the order they had, `challenge_end, job_id` for the two challenge
window lists and `resolve_by, job_id` for the disputes, which is the order the
keeper wants them in; paging those by job id while ordering by the deadline
would let a page skip a row whose deadline sorts before a row already returned.

## Running

```bash
export CHAIN_ID=5042002
export RPC_URL=https://rpc.testnet.arc.io
export SQUARE_DEPLOYMENT_FILE=        # empty takes the addresses from @squaresdk/core for a known chain
export SQUARE_VERSION=0.1.0           # what /health and /version report, and what every log line carries
export DATABASE_URL=postgres://...    # empty means an ephemeral PGlite database
export START_BLOCK=                    # empty takes the block from the deployment record; neither is an error, not a scan from genesis
export BATCH_BLOCKS=2000              # Arc refuses a span above roughly 20 000 blocks, and a refused batch is halved until it fits
export POLL_INTERVAL_MS=3000
export PORT=3010
export CORS_ORIGINS=                  # comma separated browser origins; localhost is always allowed
export MAX_LAG_BLOCKS=100             # above this the lag check fails and /health answers 503
export MAX_SYNC_AGE_MS=120000         # no successful sync for this long fails the lag check
export STARTUP_GRACE_MS=60000         # how long an unmeasured lag stays healthy after start
export ALERT_INTERVAL_MS=30000
export ALERT_WEBHOOK_URL=             # empty logs the alerts instead of posting them
export ON_DEPLOYMENT_CHANGE=fail      # or restart, to delete this chain's derived rows and reindex from START_BLOCK
npx square-data migrate up
npm install --install-links && npm run build && npm start
```

`SQUARE_DEPLOYMENT_FILE` is a path to a deployment record, and it decides which
addresses this indexer follows: the record is read from disk when the variable is
set, and the addresses come from `@squaresdk/core` for a known chain when it is
empty. The file is the way through a redeploy, because
`packages/core/src/deployments.ts` is updated by hand after one and until it is,
pointing this at `contracts/deployments/<chainId>.json` is what runs the indexer
against the current stack. [docs/deploy/README.md](../../docs/deploy/README.md)
lists the services as readers of that file for exactly this reason. The record
carries more than addresses: the block it was deployed in is where `START_BLOCK`
comes from when that variable is unset, and the addresses in it are what the
deployment-change check compares with `indexer_checkpoints` on start.

`SQUARE_VERSION` is the version `/health` and `/version` report and the logger
stamps on every line. It falls back to `0.1.0` whatever is deployed, so an
operator who wants those to name the image tag has to pass the tag in.

`START_BLOCK` is the block the settlement stack was deployed in. A deploy script
writes it into the deployment record as `block`, and the indexer reads it from
there when the variable is unset, so the number lives in one place rather than in
an operator's notes. When neither the record nor the variable carries one the
indexer fails to start and says so: scanning Arc from genesis is roughly a day of
catching up with the lag check red the whole way, which is never what anyone
wanted.

`BATCH_BLOCKS` is a request size, not a promise. Arc's `eth_getLogs` refuses a
span above roughly twenty thousand blocks with code `-32012`, and a batch set
wider than that used to fail, be retried unchanged, and stall the cursor forever
behind a repeating `indexer.sync_failed`. A refused range is now halved until the
node accepts it, logged once per split as `indexer.batch_split`, and the batch
still ends where it was meant to. The splitting is a recovery, not a setting:
each split costs an extra request, so `indexer.batch_split` in the log means
`BATCH_BLOCKS` should come down.

Migrations are never run at boot against a real database; `square-data
migrate up` is the explicit step. Only the ephemeral PGlite mode migrates
itself, because there is nothing to preserve.

## Tests

`npm test` runs the reducer suite and the isolation suite hermetically, the
second one driving encoded logs through a PGlite journal to cover the poison
event, the rolled-back batch, the deployment change and the rows it deletes,
the hook call the kernel could not complete, the refund a dead resolver forced,
and the stalled health check. Two more suites run hermetically as well: the API suite drives
`app.fetch` with an `Origin` header and reads the header off the `GET` answer,
and walks a PGlite mirror holding more rows than the default limit through
every list to prove the bound, the cursor and the counts on `/overview`,
and the checks suite runs the four health checks over an empty database that
never synced, a checkpointed restart, a normal run and a frozen loop. With an
anvil at
`http://127.0.0.1:8545` carrying the local stack
(`contracts/script/DeployLocal.s.sol`) it also runs the sync test with a
PGlite journal and the differential test that drives every settlement path
and compares the rebuilt state with the chain.
