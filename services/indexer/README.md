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
- `sync.ts` fetches logs for the five contracts in block batches, journals
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
- On start it compares the address stored in `indexer_checkpoints` with the
  address in the deployment file. A mismatch means the checkpoint belongs to an
  earlier deployment on the same chain and resuming from it would silently skip
  every event of the new contracts, so the indexer refuses to start unless
  `ON_DEPLOYMENT_CHANGE=restart` tells it to reindex from `START_BLOCK`.
- No reorg handling. Arc has deterministic finality: a block is either final or
  absent, so `latest` is safe to index.
- `api.ts` serves `/jobs/open`, `/jobs/in-window`, `/jobs/finalizable`,
  `/jobs/provider/:address`, `/jobs/:id`, `/listings`, `/disputes/open`,
  `/status`, `/quarantine`, plus `/health`, `/metrics` and `/version`.
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

## Running

```bash
export CHAIN_ID=5042002
export RPC_URL=https://rpc.testnet.arc.io
export DATABASE_URL=postgres://...    # empty means an ephemeral PGlite database
export START_BLOCK=<deployment block>
export BATCH_BLOCKS=2000
export POLL_INTERVAL_MS=3000
export PORT=3010
export CORS_ORIGINS=                  # comma separated browser origins; localhost is always allowed
export MAX_LAG_BLOCKS=100             # above this the lag check fails and /health answers 503
export MAX_SYNC_AGE_MS=120000         # no successful sync for this long fails the lag check
export STARTUP_GRACE_MS=60000         # how long an unmeasured lag stays healthy after start
export ALERT_INTERVAL_MS=30000
export ALERT_WEBHOOK_URL=             # empty logs the alerts instead of posting them
export ON_DEPLOYMENT_CHANGE=fail      # or restart, to reindex from START_BLOCK after a redeploy
npx square-data migrate up
npm install --install-links && npm run build && npm start
```

Migrations are never run at boot against a real database; `square-data
migrate up` is the explicit step. Only the ephemeral PGlite mode migrates
itself, because there is nothing to preserve.

## Tests

`npm test` runs the reducer suite and the isolation suite hermetically, the
second one driving encoded logs through a PGlite journal to cover the poison
event, the rolled-back batch, the deployment change and the stalled health
check. Two more suites run hermetically as well: the API suite drives
`app.fetch` with an `Origin` header and reads the header off the `GET` answer,
and the checks suite runs the four health checks over an empty database that
never synced, a checkpointed restart, a normal run and a frozen loop. With an
anvil at
`http://127.0.0.1:8545` carrying the local stack
(`contracts/script/DeployLocal.s.sol`) it also runs the sync test with a
PGlite journal and the differential test that drives every settlement path
and compares the rebuilt state with the chain.
