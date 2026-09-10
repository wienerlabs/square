# Services on Arc Testnet, the 2026-09-07 run (superseded)

> **Superseded, and kept as a record of one run.** The two services ran on
> **2026-09-07** against the settlement stack that was live that day: `SquareJob`
> `0x2570a151…`, `KeeperEvaluator` `0x6c62D57B…`, `Arbitration` `0xA10C2e9f…`,
> `ClaimMarket` `0xc5495bc5…`, `SquareHook` `0x92EC31aA…`, indexed from block
> 60 823 791. That stack was replaced on [2026-09-08](redeploy-2026-09-08.md)
> and again on [2026-09-09](redeploy-2026-09-09.md), so the addresses in force
> are the ones on the later page. Nothing below reproduces against the current
> stack: the block numbers, the twelve rebuilt jobs and the finalize transaction
> all belong to the earlier one. What a redeploy invalidates and in which order
> to redo it is the checklist in [docs/deploy/README.md](./README.md), which
> lists this page.
>
> **The `/status`, `/quarantine` and `/health` bodies below are the shape this
> build serves, not output captured from that run.** The run's own bodies were
> kept here until they became misleading: they reported `"critical":false` for
> the indexer's `lag` check and the keeper's `balance` check, which
> [#104](https://github.com/wienerlabs/square/issues/104) named as a defect and
> [#147](https://github.com/wienerlabs/square/pull/147) fixed, and they showed
> three checks per service where the code now serves four. Everything outside
> those blocks is what happened.

Both services from this branch, against the real chain, sharing one Postgres
(`square_testnet`) migrated with `square-data migrate up`. Nothing here is a
mock: the indexer read the chain, the keeper sent a real transaction and was
paid by the kernel.

## Indexer

Started at the deployment block (60 823 791) and caught up to the head
(60 843 449) in four batches, journaling every log and rebuilding twelve jobs,
the disputes, the listings and both ledgers from events alone.

`GET /jobs/finalizable` listed jobs 8, 9 and 11 (0.5 USDC budgets from the
ERC-4337 measurement, windows closed) and later job 12.

`/status` carries seven fields (`services/indexer/src/api.ts`). The last three
arrived with #147 and are the ones an operator watches: how many challenge
windows the reducer has seen, how many `SubmissionTimed` events arrived with no
window configured (which means `START_BLOCK` is after the `KeeperEvaluator`
deployment), and how many events were set aside instead of failing their batch.
In the block below the first four values are the ones the run recorded; the last
three did not exist yet, so they carry the value a clean run produces.

```
GET /status
{"chainId":5042002,"lastIndexedBlock":"60843449","chainHead":"60843449","jobs":12,"windows":1,"missingWindowEvents":0,"quarantined":0}
```

`GET /quarantine` lists the events the indexer could not journal or reduce, in
arrival order, at most the last hundred. It is empty when `quarantined` is zero,
and each entry carries `contract`, `eventName`, `blockNumber`, `logIndex`,
`txHash`, `stage` (`journal` or `reduce`) and `error`.

```
GET /quarantine
[]
```

`/health` runs four checks and both `lag` and `quarantine` are new shape since
the run: `lag` is critical, its detail carries the limit, it reports that it has
not measured yet while either head is unsampled rather than subtracting a head
nobody read, and it fails when the last successful sync is older than
`MAX_SYNC_AGE_MS`. `quarantine` is not critical, so an event set aside degrades
the service rather than taking it out of rotation. The check names, flags and
details below come from `services/indexer/src/checks.ts`; the latencies are the
ones the run recorded.

```
GET /health
{"status":"healthy","service":"square-indexer","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":2},"rpc":{"ok":true,"critical":true,"latencyMs":65},"lag":{"ok":true,"critical":true,"latencyMs":1,"detail":"0 blocks behind, limit 100"},"quarantine":{"ok":true,"critical":false,"latencyMs":0,"detail":"no event set aside"}},"uptimeSeconds":202}
```

An indexer more than `MAX_LAG_BLOCKS` behind answers `503` with
`"status":"unhealthy"`, because `lag` is critical. That is the case a readiness
probe has to see.

## Keeper

Cranker key `0xcc55417B17a31163325cB83Cf6900C98BE595e7A`, poll every 15 s,
minimum margin 20 %.

- Jobs 8, 9 and 11 were skipped as unprofitable and journaled once each: fee
  0.0025 USDC against a gas cost of about 0.010 USDC at the live gas price. The
  keeper never sends a losing transaction.
- Job 12 (3 USDC budget, provider agent 892531) closed its window at
  1788747974 and was finalized on the next tick:
  [`0xd9fb735cf5c60b55333a8465708fa1d61f7e707bd8e6ce9c7fa1cc2c095d2a07`](https://testnet.arcscan.app/tx/0xd9fb735cf5c60b55333a8465708fa1d61f7e707bd8e6ce9c7fa1cc2c095d2a07),
  332 342 gas, 0.015 USDC evaluator fee forwarded to the cranker by
  `KeeperEvaluator`. The indexer mirrored the completion (status 3, payee the
  provider, 10 000 bps) within one poll.

```
GET /metrics (excerpt)
square_finalize_pending_total{service="square-keeper"} 3
square_finalize_oldest_pending_age_seconds{service="square-keeper"} 260
square_disputes_open_total{service="square-keeper"} 0
square_keeper_actions_total{action="finalize",result="skipped",service="square-keeper"} 39
square_keeper_actions_total{action="finalize",result="success",service="square-keeper"} 1
square_keeper_fee_earned_usdc{service="square-keeper"} 0.015
```

`square_finalize_oldest_pending_age_seconds` keeps growing for the three
unprofitable jobs, which is correct: they are finalizable and nobody rational
will finalize them. The `keeperStalled` alert is about jobs the keeper would
take and did not; a deployment that wants those small jobs finalized lowers
`MINIMUM_MARGIN_BPS` or raises the evaluator fee.

The keeper also runs four checks (`services/keeper/src/checks.ts`), and two of
them changed after the run: `balance` is critical and no longer compares against
a fixed wei constant, it asks how many finalize sends the balance buys at the
live gas price and fails below `MIN_ACTIONS_FUNDED`; `mirror` reports whether
`DATABASE_URL` is set at all. The `balance` detail below is the shape that
balance and gas price produce, and the run's balance covered a hundred sends.

```
GET /health
{"status":"healthy","service":"square-keeper","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":1},"rpc":{"ok":true,"critical":true,"latencyMs":70},"balance":{"ok":true,"critical":true,"latencyMs":176,"detail":"1200573136688000000 wei of native USDC covers 106 finalize sends at 25000000000 wei per gas and 450000 gas each, minimum 3"},"mirror":{"ok":true,"critical":false,"latencyMs":0,"detail":"reading the mirror an indexer writes"}},"uptimeSeconds":198}
```

## Reproduce

Against the current stack, with the addresses of the
[2026-09-09 redeploy](redeploy-2026-09-09.md) and its deployment block, not the
numbers above:

```bash
export CHAIN_ID=5042002 RPC_URL=https://rpc.testnet.arc.io DATABASE_URL=postgres://localhost:5432/square_testnet
export SQUARE_DEPLOYMENT_FILE=contracts/deployments/5042002.json
(cd packages/data && node dist/cli.js migrate up)
(cd services/indexer && START_BLOCK=<deployment block> PORT=3010 CORS_ORIGINS=https://square-wienerlabs.vercel.app node dist/main.js &)
(cd services/keeper && KEEPER_PRIVATE_KEY=0x... PORT=3011 node dist/main.js &)
curl -s localhost:3010/status; curl -s localhost:3010/quarantine; curl -s localhost:3011/actions
curl -H "Origin: https://square-wienerlabs.vercel.app" -i -s localhost:3010/status
```

A database that already holds an earlier deployment's rows is the case the
indexer refuses to start on: point `DATABASE_URL` at a fresh database, or set
`ON_DEPLOYMENT_CHANGE=restart`, which deletes that chain's derived rows and the
event journal before it reindexes from `START_BLOCK`.

The last curl is the check the first ones cannot make: `curl -s` sends no origin
and enforces nothing, so it passes whether or not the browser would be allowed
to read the answer. What to look for in its headers, which is again the shape
this build produces and not output recorded from the run above:

```
HTTP/1.1 200 OK
access-control-allow-origin: https://square-wienerlabs.vercel.app
vary: Origin
content-type: application/json
```

An origin outside `CORS_ORIGINS` still gets `200` and the full body, with no
`access-control-allow-origin` header. That is the case a browser turns into
`TypeError: Failed to fetch` while the indexer's log shows a served request.
