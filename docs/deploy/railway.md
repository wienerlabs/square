# The services on Railway

**Status:** the setup, written before the project exists ([#336][i336]);
what it needs from the repository is in place (the images, the pipeline that
builds and publishes them, the redeploy hook). The account, the project, the
keeper's key and where the alerts go are named when the services are brought
up, and the record of that is `docs/deploy/services-5042002-<date>.md`. The
provider and the shape are [service-hosting.md](../decisions/service-hosting.md).

[i324]: https://github.com/wienerlabs/square/issues/324
[i336]: https://github.com/wienerlabs/square/issues/336
[i347]: https://github.com/wienerlabs/square/issues/347
[i353]: https://github.com/wienerlabs/square/issues/353
[i370]: https://github.com/wienerlabs/square/issues/370

## The pieces

| On Railway | Source | Listens | What it is for |
|---|---|---|---|
| `postgres` | Railway's managed Postgres | | the mirror the indexer writes and the keeper reads ([data-layer.md](../design/data-layer.md)) |
| `square-indexer` | `ghcr.io/wienerlabs/square-indexer:main` | 3010 | `/status`, `/jobs/finalizable`, `/actions`, the app's inbox; feeds the keeper |
| `square-keeper` | `ghcr.io/wienerlabs/square-keeper:main` | 3011 | finalizes every job whose window closed; `/actions` is its journal |
| `square-screener` | `ghcr.io/wienerlabs/square-screener:main`, once [#370][i370] gives it a Dockerfile and a row in `services.yml` | 3012 | screens funding and release parties against TRM; the keeper asks it before a release |
| `square-prover` | `ghcr.io/wienerlabs/square-prover:main` | 3003 | the app's job page only ([#347][i347]); its artifacts are [#353][i353]'s, below |
| `square-hosted` | `ghcr.io/wienerlabs/square-hosted:main` | 3000 | the hosted agent of [#336][i336]'s addendum: an agent registered on Arc, its card resolvable, taking work through `square_hire` and delivering it |

One project, one environment. Every service is a **Docker image** deployed
from GHCR, not a build of the repository on Railway: the image that ran the
hermetic smoke test in CI is the image that runs against Arc, under a tag that
names the commit, and nothing about the build depends on the provider.

## How the images are made and moved

`.github/workflows/services.yml` builds `services/<name>/Dockerfile` with the
repository root as context on every push to `main` that touches the service or
a package it copies, starts the container with a dead RPC endpoint and no
database and requires `/health` to answer, then pushes two tags:

- `ghcr.io/wienerlabs/square-<name>:sha-<12 hex>`: the record, written once;
- `ghcr.io/wienerlabs/square-<name>:main`: what `main` built last.

The Railway services point at `:main`. After the push the workflow runs
`railway redeploy --service square-<name> --from-source --yes`, which makes
the service pull the tag again and deploy it, gated on its health check. That
step needs a **project token** (Railway: project settings, Tokens, scoped to
the environment) stored as the repository secret `RAILWAY_TOKEN`; without it
the workflow says so in its summary and the image is still published, and the
operator redeploys by hand (the service's Redeploy, or the same CLI command).
There is no `:latest`, and `sha-` tags are never moved, so
`docs/deploy/services-5042002-<date>.md` can name the exact build that ran.

After the first run each package is private; make `square-indexer`,
`square-keeper`, `square-prover` and `square-hosted` public once (Packages,
the package, settings, visibility), so Railway pulls anonymously. A private
package works too, with registry credentials on the service.

## Setting a service up

For each of the two services the keeper's job needs (the indexer and the
keeper), and later the screener:

1. New service, **Docker image**, `ghcr.io/wienerlabs/square-<name>:main`.
2. Variables, below. `PORT` is set explicitly to the port in the table, and
   the service's public domain targets that port: Railway routes a domain to
   one target port, which it can detect from what the service bound when the
   domain is added after the first deploy, or is told by hand; setting both
   removes the guess. The prover reads `PROVER_SERVICE_PORT` rather than
   `PORT`.
3. Settings, deploy: health check path `/health`, restart policy on failure.
   Railway queries the health check until it answers 2xx **before cutting
   traffic over to a new deployment, and not afterwards**; what watches the
   services after that is below.
4. A public domain, so that `/health` and `/status` can be read from outside,
   which is what [#336][i336]'s acceptance asks for. Nothing on the services
   needs to be reachable from outside for them to do their job: the keeper
   talks to the chain and the database only, the indexer is read by the app
   and by whoever asks; the domain is for reading them.

**The deployment record.** `SQUARE_DEPLOYMENT_FILE` stays unset. The image's
`@squaresdk/core` carries the Arc record (`deploymentFor(5042002)`), and
`packages/core/test/deployments.test.ts` holds it equal to
`contracts/deployments/5042002.json`, so the addresses reach the services the
way the decision wants (written by the deploy script, checked in, built in)
without a file to mount. A redeploy of the contracts ([#324][i324]) changes
`deployments.ts`, which rebuilds the images; the indexer then finds a
checkpoint that belongs to the old stack and refuses to start, by design
(`ON_DEPLOYMENT_CHANGE=fail`). Set `ON_DEPLOYMENT_CHANGE=restart` for that one
deploy, which deletes the chain's derived rows and reindexes from
`START_BLOCK`, or point it at a fresh database; either way `START_BLOCK`
becomes the new stack's block.

**The schema.** The services do not migrate a database they were given
(`compose.yaml` runs the migration as a one-shot before them). On Railway the
indexer service's pre-deploy command does it, from the indexer image, before
every deploy:

```
node node_modules/@squaresdk/data/dist/cli.js migrate up
```

It is idempotent. The same command from a laptop against the database's public
URL does the same once.

### Variables

Reference variables are Railway's: `${{Postgres.DATABASE_URL}}` is the managed
database's URL, and a variable marked as sealed is written once and never shown
again, which is where `KEEPER_PRIVATE_KEY` goes.

**square-indexer**

| Variable | Value | |
|---|---|---|
| `CHAIN_ID` | `5042002` | |
| `RPC_URL` | `https://rpc.testnet.arc.io` | required |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | required; without it the indexer keeps an in-memory mirror the keeper never sees |
| `START_BLOCK` | the block the stack was deployed in (`docs/deploy/redeploy-<date>.md`) | required until the record carries `block` ([#324][i324]) |
| `PORT` | `3010` | |
| `CORS_ORIGINS` | the app's origin, `https://square-wienerlabs.vercel.app` | the app's inbox reads `/jobs/provider/<address>` from the browser |
| `ALERT_WEBHOOK_URL` | where alerts go | optional; without it alerts are log lines |
| `SQUARE_VERSION` | the `sha-` tag deployed | optional; reported by `/health` and `/status` |
| `POLL_INTERVAL_MS`, `BATCH_BLOCKS`, `MAX_LAG_BLOCKS`, `MAX_SYNC_AGE_MS`, `STARTUP_GRACE_MS`, `ALERT_INTERVAL_MS`, `ON_DEPLOYMENT_CHANGE` | defaults | `services/indexer/src/config.ts` |

**square-keeper**

| Variable | Value | |
|---|---|---|
| `CHAIN_ID` | `5042002` | |
| `RPC_URL` | `https://rpc.testnet.arc.io` | required |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | required; the keeper reads the mirror the indexer writes |
| `KEEPER_PRIVATE_KEY` | sealed | required; a key of its own, never a published test key, funded with native USDC for gas ([#336][i336] names who holds and funds it) |
| `PORT` | `3011` | |
| `SCREENER_URL` | `https://<square-screener's domain>` | once the screener runs ([#370][i370]); on a hook that screens, a keeper without it finalizes into refusals |
| `ALERT_WEBHOOK_URL` | where alerts go | `keeperStalled` fires when a finalizable job waits longer than `MAX_PENDING_AGE_SECONDS` |
| `SQUARE_VERSION` | the `sha-` tag deployed | optional |
| `FINALIZE_GAS`, `FINALIZE_DECIDED_GAS`, `MINIMUM_MARGIN_BPS`, `MIN_ACTIONS_FUNDED`, `POLL_INTERVAL_MS`, `RECORD_EXPIRIES`, `EXPIRY_*`, `RETRY_*`, `MAX_PENDING_AGE_SECONDS`, `MAX_TICK_AGE_SECONDS`, `SCREENER_TIMEOUT_MS` | defaults | `services/keeper/src/main.ts`; `FINALIZE_GAS` is what the profitability decision assumes and is [#344](https://github.com/wienerlabs/square/issues/344)'s |

`/health` on the keeper is 503 while the key cannot pay for `MIN_ACTIONS_FUNDED`
finalizes at the current gas price, so an unfunded key fails the deploy's
health gate rather than starting a keeper that skips every job.

**square-prover**

| Variable | Value | |
|---|---|---|
| `PROVER_SERVICE_PORT` | `3003` | the prover reads this, not `PORT` |
| `CORS_ORIGINS` | the app's origin | the job page posts to `/prove` from the browser |
| `PROVER_MAX_CONCURRENCY`, `PROVER_MAX_QUEUE`, `PROVER_PROOF_TIMEOUT_MS` | defaults | `services/prover/src/index.js` |

The prover's `/health` is 503 until `payment.wasm` and `payment.zkey` are
readable under `/artifacts`, which the image does not carry: the key the
shared stack's verifier is built from, and how a hosted prover gets exactly
that key and says so in `/health`, is [#353][i353]. Until it lands the prover
is not deployed, and the app's job page binds proofs only where
`NEXT_PUBLIC_PROVER_URL` points at a prover someone runs. The institutions'
own tools do not use it either way ([#347][i347]).

**square-hosted**

| Variable | Value | |
|---|---|---|
| `SQUARE_HOSTED_CONFIG` | the agent's configuration, as JSON (`packages/hosted/README.md`); sealed, since a tool's `headers` may carry a bearer token | required; the image runs `square-hosted` with no path |
| `SQUARE_PRIVATE_KEY` | sealed | required; the wallet that owns the configuration's `agentId`, registered on Arc with `square register` and funded with native USDC for `submit` |
| `ANTHROPIC_API_KEY` | sealed | the platform tier's model key; an `own`-tier configuration carries the institution's, sealed under `SQUARE_SEAL_SECRET` |
| `SQUARE_SEAL_SECRET` | sealed | only with an `own`-tier configuration |
| `PORT` | `3000` | the card's `url` in the configuration is this service's public domain |
| `SQUARE_CHAIN_ID`, `SQUARE_RPC_URL` | defaults: Arc Testnet and its endpoint | |
| `SQUARE_PROVER_ARTIFACTS` | not set | only a configuration with a `compliance` block (an agent that delegates) proves, and that needs the circuit's files beside it, which is [#353][i353]'s question again; the first hosted agent takes work and does not delegate |

The health check path is `/.well-known/agent-registration.json`: the card is
served once the chain answered and the agent is up. `/a2a` is what
`square_hire` talks to; a `compliance` block's duty state is written in the
container's working directory, so an agent that delegates wants a volume there
or accepts recovering from the chain after a restart (`proof-freshness.md`).

## Watching it

Railway's health check is a readiness gate for cutovers, not a monitor. Three
things watch the services once they are live:

- the services' own alerting: `keeperStalled` (a finalizable job older than
  `MAX_PENDING_AGE_SECONDS`, a tick older than `MAX_TICK_AGE_SECONDS`) on the
  keeper, `indexerLagging` (more than `MAX_LAG_BLOCKS` behind) and
  `hookWriteFailures` on the indexer, posted to `ALERT_WEBHOOK_URL`;
- the restart policy: a process that exits is started again;
- `/health` over the public domain, probed from outside on a schedule by
  whatever the operator runs for that; `scripts/health.sh` is the local shape
  of that probe.

`/status` on the indexer carries `chainHead` and the block it has reached;
the two moving together is the evidence [#336][i336] asks for.

## The record

When the services are up, `docs/deploy/services-5042002-<date>.md` holds: the
project and environment, each service's image `sha-` tag and public domain,
the `/health` and `/status` bodies as read from outside, the keeper's address
and its balance, the block range the indexer covered, and, for a job whose
window closed after the bring-up, the keeper's `/actions` row and the
transaction on Arcscan. That file supersedes
[services-5042002.md](services-5042002.md), which is the one-machine run of
2026-09-07.

## Not in this document

- The screener's image and service ([#370][i370]); it joins `services.yml`'s
  matrix with its Dockerfile, and this document's table gets its variables
  (`RPC_URL`, `CHAIN_ID`, `SCREENING_REGISTRY`, `SCREENER_PRIVATE_KEY`,
  `SCREENING_CANARY`, `PORT`, `TRM_BASE_URL`, `CORS_ORIGINS`).
- A hosted agent that delegates: it proves in its own process and needs the
  circuit's files beside it, [#353][i353]'s question; the first hosted agent
  takes work and does not delegate.
- The application, which is static files on Vercel (`deploy.yml`) and only
  needs `NEXT_PUBLIC_INDEXER_URL` and, if a prover is hosted,
  `NEXT_PUBLIC_PROVER_URL` pointed at the domains above.
