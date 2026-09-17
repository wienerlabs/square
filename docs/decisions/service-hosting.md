# How the services are hosted

**Status**: the shape is decided, and the provider: Railway (2026-09-15). The
account, the keeper's key and the alert target are still to be named.

## What is decided

Each long-running process ships as an OCI image built from a Dockerfile in
this repository, and nothing in any of them is specific to a hosting provider:

| Service | Image | Listens | Needs |
|---|---|---|---|
| prover | `services/prover/Dockerfile` | 3003 | `payment.wasm` and `payment.zkey` on a mounted path; serves the app's job page and development, not the institutions' own tools |
| indexer | `services/indexer/Dockerfile` | 3010 | Postgres, an RPC endpoint, a deployment file |
| keeper | `services/keeper/Dockerfile` | 3011 | Postgres, an RPC endpoint, a deployment file, a funded key |
| screener | `services/screener/Dockerfile` | 3012 | an RPC endpoint, the registry's address, a registered signing key, a canary; TRM reachable |
| app | `app/Dockerfile` | 80 | Nothing at run time; it is static files |
| hosted agent | `packages/hosted/Dockerfile` | 3000 | a wallet that owns an ERC-8004 agent, a model key, the configuration in `SQUARE_HOSTED_CONFIG`; the circuit's files beside it only if it delegates |

Every one of them takes its whole configuration from environment variables and
reports at `/health`, returning 503 when a check marked critical fails. That is
enough for any orchestrator that can run a container, pass environment and poll
an HTTP endpoint, which is the point: the decision is to depend on that
interface and on nothing else.

`compose.yaml` is the reference deployment. It is what runs locally, and a
provider that reads a compose file can run it directly; one that does not can
be handed the same five images and the same environment.

**The prover is not where an institution proves** ([#347](https://github.com/wienerlabs/square/issues/347),
[prover-trust-boundary.md](prover-trust-boundary.md)). A proof takes the whole
policy as input, `policy_salt` included, and whoever runs the prover can open
every value the commitment hides. So the CLI, the MCP server and the hosted
agent prove in their own process from the circuit's files. A prover this
project hosts serves the app's job page, and its operator sees the mandate of
every policy sent to it from that page.

## What that rules out

- **No provider-specific runtime.** No serverless handler signature, no
  vendor SDK, no build plugin. The keeper is a process with a loop and a wallet
  and cannot be a request handler; the indexer holds a cursor and cannot be one
  either. Both need somewhere that keeps a process alive.
- **No secret in an image or a file in the repository.** The keeper's key
  arrives as `KEEPER_PRIVATE_KEY` and compose refuses to start without it. The
  local default is anvil's published test account and is in `.env.example`
  where it is visible as such.
- **No state in a container.** Postgres is a URL. The chain is a URL. The
  deployment addresses are a mounted file, written by the deploy script rather
  than compiled into anything.

## The provider: Railway

Decided on 2026-09-15 ([#336](https://github.com/wienerlabs/square/issues/336)),
between Railway and a Hostinger VPS. What the choice had to satisfy is above:
a container runtime that keeps a process alive, a managed Postgres or one we
run, outbound access to an RPC endpoint, a secret store for one private key,
and an HTTP health probe. Railway meets all five directly: a service per
Dockerfile, a managed Postgres, variables and secrets per service, a health
check path per service, and outbound network. A VPS would have run
`compose.yaml` as it is, with Postgres, backups and updates ours to run; the
difference is operations, not code, and the smaller operations won.

The screener is the fourth service image and the fifth process in
`compose.yaml` ([#370](https://github.com/wienerlabs/square/issues/370)); the
shared stack installs screening ([#372](https://github.com/wienerlabs/square/issues/372),
decided yes), and the screener needs TRM reachable from the provider's network. The prover
serves the app's job page only (above).

The setup itself is [docs/deploy/railway.md](../deploy/railway.md): every
service is a Docker image from GHCR that `.github/workflows/services.yml`
builds, smoke-tests and publishes on each push to `main` under a tag that
names the commit, and tells the hosted service to pull; Railway builds nothing.

## What is not decided

The Railway account and project the services live in, who holds the keeper's
key and funds it, and where `ALERT_WEBHOOK_URL` points. Those are named in
[#336](https://github.com/wienerlabs/square/issues/336) when the services are
brought up, and the record of that run is `docs/deploy/services-5042002-<date>.md`.
The application is separate and simpler, because it is static files and can go
anywhere that serves them.

## The application today

The application is already served from a static host wired to this repository
(`vercel.json` at the root, and the `site/` bundle beside it). That is a
deployment of the static bundle only; it does not host any of the three
services, which is the gap this document is about.
