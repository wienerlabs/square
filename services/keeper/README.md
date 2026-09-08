# Keeper

Finalizes Square jobs whose challenge window closed, applies arbitration
decisions once they are reached, and records expiries for reputation. It is
paid by the kernel: `KeeperEvaluator` forwards the evaluator fee to whoever
sends the finalizing transaction. It only acts when that fee covers the gas
with a margin.

## How it decides

1. The Postgres mirror (`jobs`) says which jobs to look at: submitted, not
   disputed, `challenge_end <= now`, plus submitted jobs under dispute.
2. The chain says whether to act: `getJobRecord`, `isDisputed`,
   `challengeEndsAt` and the arbitration decision are read again for every
   candidate. The database never decides anything that moves money.
3. `decide()` compares the fee (`budget x evaluatorFeeBP / 10 000`, snapshotted
   at funding) with the gas cost at the current gas price plus
   `MINIMUM_MARGIN_BPS`. Unprofitable jobs are skipped and journaled.
4. `finalize`, `finalizeDecided` or `lapse` is sent; the receipt, gas and fee are
   written to `keeper_actions` and the metrics.

Transactions are sent one at a time from a single key, so nonces never race.
Run one keeper per key. Two keepers on different keys compete honestly: the
kernel pays whichever lands first and the other's transaction reverts with
`NotSubmitted`, which is journaled as a failure and costs the loser a revert.

## Running your own

Finalization is permissionless by construction. Anyone can run this service
against the public contracts and collect the fees:

```bash
export CHAIN_ID=5042002
export RPC_URL=https://rpc.testnet.arc.io
export KEEPER_PRIVATE_KEY=0x...      # holds native USDC for gas
export DATABASE_URL=postgres://...   # shared with an indexer, or empty for in-memory
export POLL_INTERVAL_MS=15000
export MINIMUM_MARGIN_BPS=2000
export ALERT_WEBHOOK_URL=https://...  # optional
npm install --install-links && npm run build && npm start
```

The keeper reads the same tables the indexer writes. Run `square-indexer`
against the same `DATABASE_URL`, or leave `DATABASE_URL` empty for a
single-process setup where the keeper holds an ephemeral PGlite database and
you run the indexer in the same process group. Contract addresses come from
`@squaresdk/core` for known chains or from `SQUARE_DEPLOYMENT_FILE`.

Endpoints: `/health`, `/metrics` (Prometheus), `/version`, `/actions` (last
50 journal rows).

## Signals

| Metric | Meaning |
|---|---|
| `square_finalize_pending_total` | jobs whose window closed and are not finalized |
| `square_finalize_oldest_pending_age_seconds` | how long the oldest of them has waited: the one number that says the keeper stopped |
| `square_keeper_actions_total{action,result}` | finalize / finalizeDecided / lapse / recordExpiry outcomes |
| `square_keeper_fee_earned_usdc` | fees collected |
| `square_disputes_open_total` | open disputes |

The `keeperStalled` alert fires when the oldest pending age exceeds
`MAX_PENDING_AGE_SECONDS` (600 by default) for a minute, and resolves when it
clears. It goes to `ALERT_WEBHOOK_URL` or to the log.

## Economics

See [docs/design/keeper-economics.md](../../docs/design/keeper-economics.md).
With the default 0.5 % evaluator fee and Arc's 20 gwei gas price, a job needs
a budget of about 1.7 USDC to break even and about 5 USDC to clear the default
margin.
