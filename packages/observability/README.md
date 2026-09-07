# @squaresdk/observability

Structured logging with a redaction allowlist, Prometheus metrics, health and version
endpoints, and threshold alerting for Square's long-running services: `prover`, `indexer`
and `keeper`.

Optimistic settlement fails silently. If the keeper stops, nothing throws and nothing
returns an error; funds simply stay in escrow past the challenge window. Monitoring is
therefore a correctness requirement for Square, not a convenience, and every signal in this
package exists to make one specific silent failure loud.

```bash
npm install @squaresdk/observability prom-client
```

`express` (^4) and `hono` (^4) are optional peer dependencies. Install whichever framework
the service uses.

## Quick start

```ts
import {
  createLogger,
  createMetrics,
  createHealth,
  mountObservability,
  createAlerting,
  keeperStalled,
  indexerLagging,
  disputesPilingUp,
  logNotifier,
} from "@squaresdk/observability";

const log = createLogger({ service: "keeper", version: "0.1.0" });
const metrics = createMetrics({ service: "keeper" });
const health = createHealth({
  service: "keeper",
  version: "0.1.0",
  checks: {
    rpc: { check: async () => ({ ok: await rpcReachable() }), critical: true },
    db: { check: async () => ({ ok: await dbReachable() }), critical: true },
  },
});

mountObservability(app, { health, metrics });

const alerting = createAlerting({
  service: "keeper",
  rules: [keeperStalled({ maxPendingAgeSeconds: 600 }), indexerLagging(), disputesPilingUp()],
  notify: logNotifier(log),
});

setInterval(() => {
  metrics.setFinalizePending(pending.length);
  metrics.setOldestPendingAgeSeconds(oldestPendingAge(pending));
  void alerting.evaluate(metrics.snapshot());
}, 30_000);
```

For Hono the adapter lives on its own entry point so that Express-only services never load
`hono`:

```ts
import { observabilityRoutes } from "@squaresdk/observability/hono";

app.route("/", observabilityRoutes({ health, metrics }));
```

## Logger

`createLogger({ service, version, level?, sink?, allowlist?, maxStringLength?, clock? })`
returns `{ debug, info, warn, error, child(bindings) }`. Each call
`info(event, fields?)` writes exactly one JSON line:

```json
{"ts":"2026-09-07T10:00:00.000Z","level":"info","service":"keeper","version":"0.1.0","event":"job_finalized","jobId":"42","txHash":"0xabc","elapsedMs":812}
```

Levels are `debug < info < warn < error`; the default level is `info`. The default sink
writes to stdout, one line per call. `child(bindings)` returns a logger whose lines carry
the bindings; bindings pass through the same allowlist as fields.

### The redaction rule

Fields are filtered through an allowlist of key names. A key that is not on the allowlist
is dropped, not masked, and the number of dropped keys is reported on the line as
`dropped_fields`. Nested objects under allowed keys are filtered recursively with the same
allowlist, and arrays are filtered element by element. The allowlist you pass at creation
is merged with the built-in safe set:

```
jobId  chainId  txHash  blockNumber  elapsedMs  error  status  count  reason
endpoint  attempt  agentId  keeper  gasUsed  fee  age  rule  outcome
```

Private policy values (ceilings, address lists, categories, operator windows, request
bodies, circuit inputs) must never reach a log line. Keys such as `max_per_tx`,
`max_daily`, `blocked_addresses`, `token_whitelist`, `allowed_categories`,
`time_days_bitmask`, `policy`, `body` and `input` are not on the allowlist, so neither the
key nor the value is serialised, at any nesting depth. The test suite logs an object holding
all of them and asserts that none of the keys or values appear in the output.

Other guarantees:

- Strings longer than 2048 characters are cut and the containing object gets
  `truncated: true`.
- `Error` instances are serialised as `name`, `message`, `stack` and an `Error` `cause`
  only. Extra properties attached to an error are dropped. The message itself is passed
  through, so errors raised about request content must name the field, not the value,
  which is the discipline the prover already follows.
- `bigint` becomes a number when it fits in 53 bits, otherwise a decimal string. `Date`
  becomes an ISO string. Functions and symbols are dropped and counted.
- The line keys `ts`, `level`, `service`, `version`, `event`, `dropped_fields` and
  `truncated` are reserved and cannot be overridden by fields, even if allowlisted.
- Cyclic or very deep structures are cut at depth 8 and never throw. A sink that throws
  never propagates. A logger must not be able to take a service down.
- `redact(fields, { allowlist? })` exposes the filter as a pure function.

When you see `dropped_fields` on a line you did not expect, the fix is to add the key to
the allowlist deliberately, having decided it is safe. That decision is the whole point of
an allowlist: the default for an unknown key is silence.

## Metrics

`createMetrics({ service, prefix?, defaultMetrics?, proofDurationBuckets?, disputeResolutionBuckets? })`
returns a private `prom-client` registry plus typed helpers. Every metric carries a
`service` label. Default process metrics (`process_*`, `nodejs_*`) are collected unless
`defaultMetrics: false`. `renderMetrics(registry)` returns the exposition text and
`registry.contentType` the matching content type. The prefix defaults to `square`.

| Metric | Type | Labels | Helper | Meaning |
|---|---|---|---|---|
| `square_finalize_pending_total` | gauge | | `setFinalizePending(count)` | Jobs whose challenge window closed and that are not finalized. |
| `square_finalize_oldest_pending_age_seconds` | gauge | | `setOldestPendingAgeSeconds(seconds)` | Seconds since the window closed for the oldest such job. This is the signal that the keeper stopped. |
| `square_proof_duration_seconds` | histogram | | `observeProofDuration(seconds)`, `startProof()` | Wall-clock time of one proof attempt, successful or not. |
| `square_proof_failures_total` | counter | `reason` | `recordProofFailure(reason)`, `startProof().failure(reason)` | Failed proof attempts. |
| `square_onchain_verification_rejections_total` | counter | `rule` | `recordVerificationRejection(rule)` | Proofs the on-chain verifier rejected. |
| `square_indexer_lag_blocks` | gauge | | derived | Chain head minus indexer head. |
| `square_indexer_head_block` | gauge | | `setIndexerHead(block)` | Last block the indexer applied. |
| `square_chain_head_block` | gauge | | `setChainHead(block)` | Latest block from the RPC in use. |
| `square_rpc_failover_total` | counter | `from`, `to` | `recordRpcFailover(from, to)` | RPC endpoint switches. |
| `square_disputes_open_total` | gauge | | `setDisputesOpen(count)` | Disputes raised and not yet decided or expired. |
| `square_dispute_resolution_seconds` | histogram | | `observeDisputeResolution(seconds)` | Dispute opened to decision or expiry. |
| `square_keeper_actions_total` | counter | `action`, `result` | `recordKeeperAction(action, result)` | Keeper transactions; `result` is `success`, `failure` or `skipped`. |
| `square_keeper_fee_earned_usdc` | counter | | `addKeeperFeeUsdc(amount)` | Evaluator fees collected, in whole USDC. |

`startProof()` returns a timer with `success()` and `failure(reason)`; both observe the
duration, and `failure` also counts the failure, so attempts and failures stay consistent.
Label values are free strings: pass bounded classifications (`"witness"`, `"timeout"`), never
an error message, or the series count grows without limit. Non-finite values are ignored
rather than written.

`snapshot()` returns the current values as a plain object (`finalizePending`,
`oldestPendingAgeSeconds`, `proofAttempts`, `proofFailures`, `indexerLagBlocks`,
`disputesOpen`, and so on). It is the input to alerting.

## Health and version

`createHealth({ service, version, checks?, commit?, checkTimeoutMs? })` returns
`{ status(), version() }`.

A check is either `async () => ({ ok, detail? })` or `{ check, critical?, timeoutMs? }`.
Checks run in parallel; a throwing or hanging check counts as failed with the error or
timeout as `detail` (default timeout 5 s).

`status()` resolves to
`{ status, service, version, checks: { [name]: { ok, critical, latencyMs, detail? } }, uptimeSeconds }`
where `status` is `healthy` when every check passes, `degraded` when only non-critical
checks fail, and `unhealthy` when any check marked `critical: true` fails.

`version()` returns `{ service, version, commit?, node }`; `commit` comes from the `commit`
option or `process.env.GIT_SHA`.

## Endpoints

| Path | Body | Status |
|---|---|---|
| `GET /health` | `status()` as JSON | 200 for `healthy` and `degraded`, 503 for `unhealthy` |
| `GET /metrics` | Prometheus exposition text, `text/plain; version=0.0.4` | 200 |
| `GET /version` | `version()` as JSON | 200 |

`mountObservability(app, { health, metrics, paths? })` registers the three routes on an
Express 4 app (anything with `app.get(path, handler)` works; no runtime import of Express).
`observabilityRoutes({ health, metrics, paths? })` from `@squaresdk/observability/hono`
returns a Hono sub-app with the same routes. `observabilityHandlers()` exposes the
framework-neutral handlers for anything else. Paths can be overridden with `paths`.

Expose these on an internal port or behind the ingress ACL. `/metrics` and the `detail`
strings of health checks are meant for operators.

## Alerting

`createAlerting({ rules, notify, clock?, service? })` returns
`{ evaluate(snapshot), state() }`. Call `evaluate` on a fixed tick with `metrics.snapshot()`
(or any plain object). A rule is
`{ name, severity: "page" | "warn", evaluate: (snapshot, { now }) => { firing, detail? }, forSeconds? }`.

An alert fires once when its condition has held for at least `forSeconds`, and a single
`resolved` notification follows when it clears. Ticks in between produce nothing. If the
notifier rejects, the notification stays queued and is retried on the next tick in order,
so a webhook outage delays alerts but never duplicates or reorders them. A rule that
throws is reported in the returned `errors` and does not stop the others.

Notifications have the shape
`{ kind: "firing" | "resolved", rule, severity, at, since, heldForSeconds, service?, detail? }`.

### Built-in rules

| Rule | Condition | Snapshot keys | Defaults | Severity |
|---|---|---|---|---|
| `keeperStalled({ maxPendingAgeSeconds, forSeconds })` | oldest finalizable job older than `maxPendingAgeSeconds` | `oldestPendingAgeSeconds` | 600 s (2 x 300 s keeper slack), `forSeconds` 60 | `page` |
| `indexerLagging({ maxLagBlocks, forSeconds })` | lag above `maxLagBlocks` | `indexerLagBlocks` | 100 blocks, `forSeconds` 120 | `warn` |
| `proofFailureRate({ maxFailureRatio, windowSeconds, minAttempts, forSeconds })` | failures / attempts over the sliding window above `maxFailureRatio` | `proofAttempts`, `proofFailures` (cumulative) | 0.2 over 300 s, at least 5 attempts, `forSeconds` 0 | `warn` |
| `disputesPilingUp({ maxOpenDisputes, forSeconds })` | open disputes above `maxOpenDisputes` | `disputesOpen` | 10, `forSeconds` 0 | `warn` |

`keeperStalled` is the alert this package exists for. Size `maxPendingAgeSeconds` at twice
the slack you give the keeper after a window closes: a keeper polling every 5 minutes
should page at 10 minutes. A missing or non-numeric snapshot key never fires; absence of
telemetry is a separate condition for the scrape side (`absent()` in Prometheus).

`proofFailureRate` keeps its own ring of cumulative counter samples and measures the ratio
over the last `windowSeconds`, so a prover that starts failing after ten thousand
successful proofs is caught within the window rather than diluted by history. A counter
reset (process restart) is detected and the window starts over.

Severity can be overridden on every rule.

### Notifiers

- `webhookNotifier(url, { fetch?, headers?, timeoutMs? })` POSTs the notification as JSON
  with ISO timestamps and rejects on a non-2xx response. The error never echoes the URL,
  since webhook URLs often carry a token.
- `logNotifier(logger)` writes `alert_firing` at `error` (page) or `warn` (warn) and
  `alert_resolved` at `info`, with `rule`, `reason` and `age` fields, all on the built-in
  allowlist.

## Tests

```bash
npm test
```

The suites cover the allowlist (the private-policy test being the important one), nested
filtering, truncation, child bindings, levels, every metric helper, health transitions,
both HTTP adapters, and a simulated keeper outage that must produce exactly one page and
exactly one resolution.
