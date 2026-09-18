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
2. `now` is the chain's, not this machine's. The timestamp of the latest block
   is read once at the top of the tick, next to the gas price, and it is the
   `now` the mirror query, `decide()` and the expiry sweep all use. The contract
   compares `block.timestamp`, and on Arc that runs about a second behind the
   wall clock, so a keeper deciding by `Date.now()` simulated `finalize` for a
   window the chain had not closed yet: a `WindowOpen` revert, an error line, a
   journal row and a sixty second backoff, on roughly one window close in ten
   (#325). `Date.now()` is left to the log and the metrics, and the cadence of
   the poll and of the expiry sweep runs on the monotonic `performance.now()`,
   which a clock correction cannot move.
3. The chain says whether to act: `getJobRecord`, `isDisputed`,
   `challengeEndsAt` and the arbitration decision are read again for every
   candidate. The database never decides anything that moves money.
4. `decide()` compares the fee (`budget x evaluatorFeeBP / 10 000`, snapshotted
   at funding) with the gas cost at the current gas price plus
   `MINIMUM_MARGIN_BPS`. Unprofitable jobs are skipped and journaled.
5. `finalize`, `finalizeDecided` or `lapse` is sent; the receipt, gas and fee are
   written to `keeper_actions` and the metrics, and the gap between
   `FINALIZE_GAS` and the gas the receipt reports is exported as
   `square_finalize_gas_gap`. Neither finalize carries a compliance proof: the
   proof is the client's, bound to the job with `setComplianceProof`, and the
   crank's bytes would decide nothing (#307).
6. After the finalize loop the tick reads expired jobs whose dispute is still
   open, checks `bondSettled` on the chain, and sends `Arbitration.settleBond`
   for each, journaled as `settleBond`. Without that nothing in the stack
   returned a disputer's bond once the job expired under a dead resolver
   (#311). It earns no fee; it is the same free duty as `lapse`.
7. A send that throws is retried with exponential backoff, `RETRY_BASE_SECONDS`
   doubling up to `RETRY_MAX_SECONDS`, and the job is dropped after
   `RETRY_GIVE_UP_AFTER` attempts. A revert that only says the chain is not
   there yet, `WindowOpen` on a finalize or `NotLapsed` on a lapse, is not an
   attempt at all: it is reported as a skip, logged as `keeper.not_yet`, and
   costs no journal row and no backoff, so the next tick sends as soon as the
   chain's clock passes the deadline. Journal rows are deduplicated per job and
   capped at `RETRY_MAX_JOURNAL_ROWS` plus one row for the give-up, so a job that
   reverts on every tick costs a bounded number of rows instead of one per tick.
   A successful send clears the state for that job.
8. A job whose expiry is inside the next day is warned about once
   (`keeper.expiry_near`), not once per tick: an unprofitable job stays a
   candidate forever, and the warning is about the deadline approaching, not
   about a state that repeats. The warning is armed again only after the job
   leaves the candidate set. An expiry that already passed is not near, it is
   the expiry sweep's business.

Transactions are sent one at a time from a single key, so nonces never race.
The expiry sweep below shares that key and runs between ticks, never beside
one, for the same reason. Run one keeper per key. Two keepers on different keys
compete honestly: the kernel pays whichever lands first and the other's
transaction reverts with `NotSubmitted`, which is journaled as a failure and
costs the loser a revert.

`SIGTERM` and `SIGINT` abort the loop's signal and close the HTTP server, and
nothing else. The tick in flight runs to its end, so a `finalize` that already
reached the chain is journaled before the process goes, and the loop then
returns without starting the expiry sweep: a twenty five job batch never begins
after a shutdown was asked for. The database pool is closed after `run()`
returns, not beside it. Closing it inside the signal handler left transactions
on the chain with no row in `keeper_actions` to say who sent them, and the tick
ended as `keeper.tick_failed` instead of reporting what it did (#328).

## What a restart carries

Giving up is written down. The rest of the retry state is not, and the
difference is deliberate.

A give-up is a row in `keeper_job_state` with `finalize_gave_up = true`, and
`run()` reads those job ids back before its first tick
(`keeper.give_ups_restored`). A job the keeper gave up on stays given up across
a restart: it is skipped before any attempt, so it sends nothing, costs no gas
and adds no further journal rows. Without that, every restart would spend
`RETRY_GIVE_UP_AFTER` fresh attempts on a job that is permanently failing and
write `RETRY_MAX_JOURNAL_ROWS` more rows, which makes the journal bound a
per-process one instead of a per-job one.

`keeper_actions` is the journal and `keeper_job_state` is the state, and the
two are kept apart on purpose. The journal is append-only and `square-data
sweep` deletes rows older than ninety days without looking at them; the
give-up row it deletes is a record of the event, not the flag. The flag, the
expiry marks and the expiry backoff live in the state table, which no sweep
touches, so a ninety day old give-up is still a give-up and a ninety day old
expiry mark still keeps its job out of the sweep.

`unprofitable_journaled_at` is in the same table for the same reason. It is the
mark that makes the single `skipped` row of an unprofitable job a promise
rather than a habit of one process. While the promise lived in memory, every
restart wrote one more row for every unprofitable job in the mirror, and the
fifty rows `/actions` returns could be nothing else (#331).

Four things are per process by design, and all four are cheap:

| State | On restart | Why that is acceptable |
|---|---|---|
| Backoff window of a job not yet given up | forgotten, the next tick may retry at once | at most one attempt earlier than the schedule wanted, and `finalize` is simulated before it is sent |
| Journal budget of such a job | counted again from zero | the give-up is what bounds the total, and it survives the restart |
| `keeper.expiry_near`, warned once per job | warned once more | one line per candidate per restart, not one per tick |
| `keeper.skipped` and the skipped counter of an unprofitable job | logged and counted once more | one line and one count per unprofitable candidate per restart is what tells an operator this process is skipping them; the journal row behind it is written once, ever |

A job that was given up on is never retried on its own, not even by a keeper
build that fixes the cause. That call belongs to the operator, and it is one
statement:

```sql
update keeper_job_state set finalize_gave_up = false where chain_id = 5042002 and job_id = 42;
```

The next start restores nothing for that job and the keeper tries it again.

## A job that cannot pay for its own finalize

Profitability is decided from the mirror before the chain is asked anything.
`listFinalizable` already carries the budget and the evaluator fee the kernel
pinned at funding, and the gas price is read once per tick, so `tick()` knows
which jobs cannot cover `FINALIZE_GAS` plus `MINIMUM_MARGIN_BPS` without a
single call per job. Those are counted as `unprofitable` in the tick report,
journaled once as `skipped`, and then cost nothing: no `getJobRecord`, no
`isDisputed`, no `challengeEndsAt`. They are not pending either, so
`square_keeper_oldest_pending_age_seconds` measures jobs the keeper means to
finalize and not jobs it has already decided against.

Once means once, not once per process. The row is written by whichever process
first sets `unprofitable_journaled_at` on the job's `keeper_job_state` row, and
every process after that reads the mark and writes nothing, so a job that stays
unprofitable for a year costs one row however often the keeper is deployed. The
log line and the skipped counter are the per process half of it
(`keeper.skipped`, once per job per process), which is what says out loud that
this process is skipping these jobs.

The three chain reads are spent only on jobs the mirror says are worth them,
which is what keeps a profitable job from waiting behind two hundred that never
will be. A job under dispute is always asked, because its next step may be a
free `lapse` whatever its budget.

## The expiry sweep

Recording an expiry for reputation is not on the finalize path. `tick()` decides
and sends settlement; the sweep runs on its own `EXPIRY_INTERVAL_MS` schedule
between ticks and reads at most `EXPIRY_BATCH_SIZE` jobs per pass, so a tick
costs the same whether the mirror holds one dead job or ten thousand and the
finalize of a profitable job never waits behind them.

The candidate query is what keeps the set shrinking. `listExpiredWithAgent`
returns expired jobs with a bound agent, under our evaluator, whose row in
`keeper_job_state` carries no `expiry_recorded_at`, is not given up, and is
not inside a backoff window, measured against the chain's latest block
timestamp like everything else the keeper decides, paged and ordered so that
the job that has waited longest comes first. An expiry this keeper recorded leaves the set through its
mark; an expiry another keeper recorded is marked on the first pass that reads
it from the chain (`keeper.expiry_already_recorded`) and leaves the set the same
way. `status = 5` is covered by the partial index `jobs_expired_with_agent`, so
the query does not scan a table that only grows. `RECORD_EXPIRIES=false` turns
the sweep off.

A failed attempt follows the same retry policy as `tick()`: the attempt count
and the next time to try are written to the state row, the delay doubles from
`RETRY_BASE_SECONDS` up to `RETRY_MAX_SECONDS`, and after `RETRY_GIVE_UP_AFTER`
attempts the job is given up on (`keeper.record_expiry_gave_up`, journaled with
`gave_up = true` so it shows on `/actions`). While a job is backing off the
query does not return it, so a job whose `recordExpiry` reverts on every pass
takes one slot in one pass and then none until its window ends, rather than a
slot in every pass forever. The mirror has such jobs today: an agent bound as
`0` reverts with `NoAgentBound` on the deployed hook until the next stack. The
operator reopens one with:

```sql
update keeper_job_state set expiry_gave_up = false, expiry_attempts = 0, expiry_next_at = null
where chain_id = 5042002 and job_id = 42;
```

## Running your own

Finalization is permissionless by construction. Anyone can run this service
against the public contracts and collect the fees:

```bash
export CHAIN_ID=5042002
export RPC_URL=https://rpc.testnet.arc.io
export KEEPER_PRIVATE_KEY=0x...      # holds native USDC for gas
export DATABASE_URL=postgres://...   # shared with an indexer, or empty for in-memory
export SQUARE_DEPLOYMENT_FILE=       # empty takes the addresses from @squaresdk/core for a known chain
export SQUARE_VERSION=0.1.0          # what /health and /version report, and what every log line carries
export PORT=3011                     # where the endpoints below are served
export POLL_INTERVAL_MS=15000
export MINIMUM_MARGIN_BPS=2000
export FINALIZE_GAS=560000           # the moduleless estimate before the first receipt; a gated stack starts from 1090000 (src/gas.ts)
export FINALIZE_DECIDED_GAS=610000
export MIN_ACTIONS_FUNDED=3          # the balance check demands gas for this many finalizes
export RECORD_EXPIRIES=true
export EXPIRY_INTERVAL_MS=60000      # how often the expiry sweep runs, between ticks
export EXPIRY_BATCH_SIZE=25          # how many expired jobs one sweep may look at
export RETRY_BASE_SECONDS=60
export RETRY_MAX_SECONDS=3600
export RETRY_GIVE_UP_AFTER=6
export RETRY_MAX_JOURNAL_ROWS=3
export MAX_PENDING_AGE_SECONDS=600
export MAX_TICK_AGE_SECONDS=300
export FINALIZE_GAS_SAMPLES=5         # receipts averaged into the gas assumption; the constants above are only the estimate before the first one
export MAX_GAS_OVERSHOOT_PERCENT=25   # a receipt over the assumption by more than this raises a warning
export PROOF_GRACE_SECONDS=3600       # how long a job whose proof the module refuses waits before it is cranked anyway; defaults to the module's timestamp tolerance
export ALERT_WEBHOOK_URL=https://...  # optional
export ALERT_INTERVAL_MS=30000        # how often the rules below are evaluated, in process
export SCREENER_URL=http://screener:3012  # square#35: screen payees before finalizing (services/screener/README.md); required when the hook screens
export SCREENER_ALLOW_PRIVATE=true    # the screener above is on a private network; link-local is refused regardless
export SCREENER_TIMEOUT_MS=30000      # per request to the screener, not per job
npm install --install-links && npm run build && npm start
```

`SCREENER_URL` is optional only while `SquareHook.screening()` is the zero
address. If the hook screens and the variable is unset the keeper **refuses to
start** and says which hook screens with which registry (square#370): with no
screener it would ask nobody to screen, every payee would go stale within the
registry's `maxAge`, and it would finalize releases the hook then refuses,
paying the client instead of the provider while `/actions` says "finalized".
Holding every job forever instead would be just as broken and much quieter, so
it stops at the one moment an operator is watching. A hook that gains a registry
while the keeper is already running is past that check, so `/health` carries a
critical `screening` check that fails for exactly that state; with
`SCREENER_URL` set, the critical `screener` check takes its place.

A hook the keeper cannot read at all is not read as a hook that screens. An RPC
that is down at boot would otherwise stop a keeper that has done nothing wrong,
and the container has to start and answer 503 rather than refuse to exist. The
keeper starts, says what it could not read (`keeper.screening_unknown`), and
screens from the registry alone until the read succeeds: it asks nobody, holds
every payee the registry does not already clear, and finalizes the rest. The
`screening` check on `/health` is failing for as long as the read is.

### A held job is not a failed one

On a stack with a compliance module the keeper asks two questions before it
cranks, and either one can make it wait instead. A wait is written to
`keeper_job_state.held_reason`, costs no retry attempt, burns no backoff, writes
no journal row, and is counted on `/status` and `/health`. The next tick looks
again.

`noProof` means the job carries no compliance proof, or bytes that are the wrong
length, or bytes that do not verify. Since #382 the evaluator refuses to settle
such a job at all and reverts `ProofRequired`, so cranking it would only burn
gas. This hold has no grace: the client is the only party who can bind a proof,
so the client is the only party who can end it. A `ProofRequired` revert that
does reach the keeper, because the job changed between the read and the send, is
recorded as this same hold rather than as a failed attempt.

`proofStale` means the module can read the proof and would refuse it. That is
the mandate's own decision and it is allowed to go against the provider, so
after `PROOF_GRACE_SECONDS` the keeper cranks anyway and the refusal is recorded
on chain. The common cause is one client with two jobs closing on the same day:
the first release moves `PolicyRegistry.spentToday` and the second job's proof
names the old figure (#345). Holding gives the client's duty a tick to bind a
fresh proof, which is the outcome that pays both providers.

The keeper reads the same tables the indexer writes, so `DATABASE_URL` has to
point at the database an indexer writes to. Leaving it empty is a development
mode only: the keeper then opens a PGlite database that lives inside its own
process, nothing writes `jobs` into it, and it will never finalize anything. It
says so at boot (`keeper.ephemeral_mirror`), on every empty tick
(`keeper.empty_mirror`) and on `/health`, where the `mirror` check reports it as
degraded.

Contract addresses come from `@squaresdk/core` for known chains, or from the
deployment record `SQUARE_DEPLOYMENT_FILE` names, which wins whenever it is set.
That is what makes the variable the way through a redeploy:
`packages/core/src/deployments.ts` is updated by hand afterwards, and until it
is, pointing this at `contracts/deployments/<chainId>.json` is what runs the
keeper against the current stack.
[docs/deploy/README.md](../../docs/deploy/README.md) counts the services as
readers of that file for exactly this reason.

`SQUARE_VERSION` is the version `/health` and `/version` report and the logger
stamps on every line. It falls back to `0.1.0` whatever is deployed, so an
operator who wants those to name the image tag has to pass the tag in. `PORT`
defaults to 3011, the port the Dockerfile exposes and `compose.yaml` publishes,
so moving the keeper off it means moving the variable and the port mapping
together. `ALERT_INTERVAL_MS` defaults to 30000: that is how often the alerting
below evaluates its rules in process, so it bounds how late either arm of
`keeperStalled` can fire.

Endpoints: `/health`, `/metrics` (Prometheus), `/version`, `/actions` (last
50 journal rows). In `/actions`, a `recordExpiry` row with no `reason` means the
expiry is recorded on chain: with a transaction hash this keeper sent it,
without one it found it already recorded.

## Signals

| Metric | Meaning |
|---|---|
| `square_finalize_pending_total` | jobs whose window closed and are not finalized |
| `square_finalize_oldest_pending_age_seconds` | how long the oldest of them has waited: the one number that says the keeper stopped |
| `square_keeper_actions_total{action,result}` | finalize / finalizeDecided / lapse / settleBond / recordExpiry outcomes, each as success, failure or skipped |
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
settlement entirely. The threshold is not a constant. The check reads the live
gas price, multiplies it by `FINALIZE_GAS` and asks how many finalize sends the
balance buys, failing below `MIN_ACTIONS_FUNDED` (3 by default) and saying the
number it counted in `detail`. A fixed wei threshold cannot do that: the 0.01
USDC it used to demand covered 0.89 finalizes at 25 gwei, so the check answered
healthy for a keeper that could not send its next transaction, and its meaning
moved with every gas price change.

The four checks live in `src/checks.ts` and are exported, so a test runs the
same code the service serves rather than a copy of it.

## Economics

See [docs/design/keeper-economics.md](../../docs/design/keeper-economics.md).
With the default 0.5 % evaluator fee, a moduleless finalize of 560 000 gas at
22 gwei needs a budget of about 2.46 USDC to break even and about 7.4 USDC to
clear a 3x margin; a gated finalize of 1 090 000 gas needs 4.80 and 14.4. The
constants are the estimate before the first receipt; the receipts take over
from there.
