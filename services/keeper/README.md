# Keeper

Finalizes Square jobs whose challenge window closed, applies arbitration
decisions once they are reached, and records expiries for reputation. It is
paid by the kernel: `KeeperEvaluator` forwards the evaluator fee to whoever
sends the finalizing transaction. It only acts when that fee covers the gas
with a margin.

## How it decides

1. The Postgres mirror (`jobs`) says which jobs to look at: submitted, not
   disputed, `challenge_end <= now`, plus submitted jobs under dispute, and in
   both queries `evaluator` must be our `KeeperEvaluator`. A job settled by a
   third-party evaluator is not a candidate: sending `finalize` for it reverts
   with `NotOurJob` and burns gas on every tick.
2. The chain says whether to act: `getJobRecord`, `isDisputed`,
   `challengeEndsAt` and the arbitration decision are read again for every
   candidate. The database never decides anything that moves money.
3. `decide()` compares the fee (`budget x evaluatorFeeBP / 10 000`, snapshotted
   at funding) with the gas cost at the current gas price plus
   `MINIMUM_MARGIN_BPS`. Unprofitable jobs are skipped and journaled.
4. `finalize`, `finalizeDecided` or `lapse` is sent; the receipt, gas and fee are
   written to `keeper_actions` and the metrics, and the gap between
   `FINALIZE_GAS` and the gas the receipt reports is exported as
   `square_finalize_gas_gap`.
5. A send that throws is retried with exponential backoff, `RETRY_BASE_SECONDS`
   doubling up to `RETRY_MAX_SECONDS`, and the job is dropped after
   `RETRY_GIVE_UP_AFTER` attempts. Journal rows are deduplicated per job and
   capped at `RETRY_MAX_JOURNAL_ROWS` plus one row for the give-up, so a job that
   reverts on every tick costs a bounded number of rows instead of one per tick.
   A successful send clears the state for that job.

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
export FINALIZE_GAS=450000
export RETRY_BASE_SECONDS=60
export RETRY_MAX_SECONDS=3600
export RETRY_GIVE_UP_AFTER=6
export RETRY_MAX_JOURNAL_ROWS=3
export MAX_PENDING_AGE_SECONDS=600
export MAX_TICK_AGE_SECONDS=300
export ALERT_WEBHOOK_URL=https://...  # optional
npm install --install-links && npm run build && npm start
```

The keeper reads the same tables the indexer writes, so `DATABASE_URL` has to
point at the database an indexer writes to. Leaving it empty is a development
mode only: the keeper then opens a PGlite database that lives inside its own
process, nothing writes `jobs` into it, and it will never finalize anything. It
says so at boot (`keeper.ephemeral_mirror`), on every empty tick
(`keeper.empty_mirror`) and on `/health`, where the `mirror` check reports it as
degraded. Contract addresses come from `@squaresdk/core` for known chains or
from `SQUARE_DEPLOYMENT_FILE`.

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
| `square_keeper_last_tick_timestamp_seconds` | when the last tick completed: the dead man's switch |
| `square_finalize_gas_used`, `square_finalize_gas_gap` | measured gas per action, and how far `FINALIZE_GAS` is from it |
| `square_alert_dispatch_failures_total{rule,stage}` | alerts that could not be evaluated or delivered |

The `keeperStalled` alert has two arms. It fires when the oldest pending age
exceeds `MAX_PENDING_AGE_SECONDS` (600 by default) for a minute, and it also
fires when no tick has completed for `MAX_TICK_AGE_SECONDS` (300 by default).
The second arm is the one that catches a keeper that is not running at all:
`square_finalize_oldest_pending_age_seconds` is written after several awaits
that can throw, so a keeper with no RPC, no database or no gas never reaches it
and the gauge holds its last value, or zero on a fresh process. Alerts go to
`ALERT_WEBHOOK_URL` or to the log, and a delivery that fails is logged as
`keeper.alert_dispatch_failed` and counted, so a broken webhook is not silent.

`/health` marks `balance` critical: a keeper out of gas answers 503, because on
Arc gas is USDC and an unfunded keeper stops the protocol's optimistic
settlement entirely.

## Economics

See [docs/design/keeper-economics.md](../../docs/design/keeper-economics.md).
With the default 0.5 % evaluator fee and the measured 465 486 gas at 22.1728
gwei, a job needs a budget of about 2.06 USDC to break even and about 6.2 USDC
to clear a 3x margin.
