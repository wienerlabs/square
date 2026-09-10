# How the services are hosted

**Status**: the shape is decided, the provider is not.

## What is decided

Each long-running process ships as an OCI image built from a Dockerfile in
this repository, and nothing in any of them is specific to a hosting provider:

| Service | Image | Listens | Needs |
|---|---|---|---|
| prover | `services/prover/Dockerfile` | 3003 | `payment.wasm` and `payment.zkey` on a mounted path |
| indexer | `services/indexer/Dockerfile` | 3010 | Postgres, an RPC endpoint, a deployment file |
| keeper | `services/keeper/Dockerfile` | 3011 | Postgres, an RPC endpoint, a deployment file, a funded key |
| app | `app/Dockerfile` | 80 | Nothing at run time; it is static files |

Every one of them takes its whole configuration from environment variables and
reports at `/health`, returning 503 when a check marked critical fails. That is
enough for any orchestrator that can run a container, pass environment and poll
an HTTP endpoint, which is the point: the decision is to depend on that
interface and on nothing else.

`compose.yaml` is the reference deployment. It is what runs locally, and a
provider that reads a compose file can run it directly; one that does not can
be handed the same four images and the same environment.

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

## What is not decided

Which provider actually runs them. That choice is about cost, region, who holds
the keeper's key and what the operations team already runs -- none of which is
a property of this code, and all of which is the project's call rather than
this document's.

What the choice has to satisfy is above: a container runtime that keeps a
process alive, a managed Postgres or one we run, outbound access to an RPC
endpoint, a secret store for one private key, and an HTTP health probe. The
application is separate and simpler, because it is static files and can go
anywhere that serves them.

## The application today

The application is already served from a static host wired to this repository
(`vercel.json` at the root, and the `site/` bundle beside it). That is a
deployment of the static bundle only; it does not host any of the three
services, which is the gap this document is about.
