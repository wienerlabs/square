# Services on Arc Testnet, live run

2026-09-07, both services from this branch, against the deployed stack and the
real chain, sharing one Postgres (`square_testnet`) migrated with
`square-data migrate up`. Nothing here is a mock: the indexer read the chain,
the keeper sent a real transaction and was paid by the kernel.

## Indexer

Started at the deployment block (60 823 791) and caught up to the head in
four batches, journaling every log and rebuilding twelve jobs, the disputes,
the listings and both ledgers from events alone.

```
GET /status
{"chainId":5042002,"lastIndexedBlock":"60843449","chainHead":"60843449","jobs":12}

GET /health
{"status":"healthy","service":"square-indexer","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":2},"rpc":{"ok":true,"critical":true,"latencyMs":65},"lag":{"ok":true,"critical":false,"latencyMs":1,"detail":"0 blocks behind"}},"uptimeSeconds":202}
```

`GET /jobs/finalizable` listed jobs 8, 9 and 11 (0.5 USDC budgets from the
ERC-4337 measurement, windows closed) and later job 12.

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
GET /health
{"status":"healthy","service":"square-keeper","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":1},"rpc":{"ok":true,"critical":true,"latencyMs":70},"balance":{"ok":true,"critical":false,"latencyMs":176,"detail":"1200573136688000000 wei of native USDC for gas"}},"uptimeSeconds":198}

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

## Reproduce

```bash
export CHAIN_ID=5042002 RPC_URL=https://rpc.testnet.arc.io DATABASE_URL=postgres://localhost:5432/square_testnet
export SQUARE_DEPLOYMENT_FILE=contracts/deployments/5042002.json
(cd packages/data && node dist/cli.js migrate up)
(cd services/indexer && START_BLOCK=60823791 PORT=3010 node dist/main.js &)
(cd services/keeper && KEEPER_PRIVATE_KEY=0x... PORT=3011 node dist/main.js &)
curl -s localhost:3010/status; curl -s localhost:3011/actions
```
