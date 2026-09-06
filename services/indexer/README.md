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
- No reorg handling. Arc has deterministic finality: a block is either final or
  absent, so `latest` is safe to index.
- `api.ts` serves `/jobs/open`, `/jobs/in-window`, `/jobs/finalizable`,
  `/jobs/provider/:address`, `/jobs/:id`, `/listings`, `/disputes/open`,
  `/status`, plus `/health`, `/metrics` and `/version`.

## Running

```bash
export CHAIN_ID=5042002
export RPC_URL=https://rpc.testnet.arc.io
export DATABASE_URL=postgres://...    # empty means an ephemeral PGlite database
export START_BLOCK=<deployment block>
export BATCH_BLOCKS=2000
export POLL_INTERVAL_MS=3000
export PORT=3010
npx square-data migrate up
npm install --install-links && npm run build && npm start
```

Migrations are never run at boot against a real database; `square-data
migrate up` is the explicit step. Only the ephemeral PGlite mode migrates
itself, because there is nothing to preserve.

## Tests

`npm test` runs the reducer suite hermetically. With an anvil at
`http://127.0.0.1:8545` carrying the local stack
(`contracts/script/DeployLocal.s.sol`) it also runs the sync test with a
PGlite journal and the differential test that drives every settlement path
and compares the rebuilt state with the chain.
