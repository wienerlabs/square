# The local stack

One command brings up a chain, the contracts on it, a database, the circuit
artifacts and the four processes:

```
make up
```

It returns only once every service reports healthy, so a zero exit status is
the claim and the health output below is the evidence. Docker, git and make are
the whole prerequisite: circom, snarkjs and forge run in containers, and the
Foundry submodules are fetched by `make up` itself, since `git clone` without
`--recursive` leaves them empty and the deployer only finds out when it fails
to compile.

| | |
|---|---|
| `make up` | Build what is missing, start everything, wait for healthy, print health |
| `make down` | Stop and remove the containers, keep the volumes |
| `make clean` | The same, and drop the chain state, the database and the artifacts |
| `make health` | Ask each service again |
| `make logs` | Follow all of them |

`make up` writes `.env` from `.env.example` on first run. Nothing in either
file is a production value; the one key is anvil's first published test
account, which controls nothing outside a local chain.

## What comes up

| Service | Port | What it is |
|---|---|---|
| anvil | 8545 | The chain, id 31337 |
| postgres | 5432 | One database, shared by the indexer and the keeper |
| deployer | — | One shot: `DeployLocal.s.sol`, writes `contracts/deployments/31337.json`. Refuses any chain but 31337 unless `DEPLOY_LOCAL_ALLOW_CHAIN_ID` names another |
| migrate | — | One shot: `square-data migrate up` |
| circuits | — | One shot: copies `payment.wasm` and `payment.zkey` into a volume |
| prover | 3003 | Groth16 proofs |
| indexer | 3010 | State rebuilt from events |
| keeper | 3011 | Finalizes jobs whose window has closed |
| app | 3000 | The static bundle behind a file server |

The three one shots are dependencies, not services. Compose runs them, waits
for a clean exit, and only then starts what needs them, so the indexer cannot
come up before the contracts are on the chain and the schema is applied.

## Where the configuration comes from

Every address, chain id and endpoint has exactly one declaration site,
`packages/core/src/deployments.ts`, and `packages/core/test/single-source.test.ts`
fails if a second copy appears anywhere in `packages/`, `services/` or `app/`.

Addresses reach the indexer and the keeper as a file rather than as code: the
deployer writes `contracts/deployments/31337.json` and both services read it
through `SQUARE_DEPLOYMENT_FILE`. Everything else is an environment variable
with a default in `.env.example`. The keeper's key has no default at all --
compose refuses to start without `KEEPER_PRIVATE_KEY`, because a signer that
silently falls back to something is worse than one that will not start.

## A measured run

2026-09-10, Docker 29.1.3 on Apple Silicon. `make clean && make up` reaches
all-healthy in **27 to 28 seconds** with the images already built, twice in a
row. A run that has to rebuild them first — which any change under
`services/`, `packages/` or `app/` causes — took **94 seconds**; both numbers
are here because quoting only the warm one would describe a case a contributor
rarely hits first.

```
$ make up
 Container square-anvil-1 Healthy
 Container square-postgres-1 Healthy
 Container square-deployer-1 Exited
 Container square-migrate-1 Exited
 Container square-circuits-1 Exited
 Container square-prover-1 Healthy
 Container square-indexer-1 Healthy
 Container square-keeper-1 Healthy
 Container square-app-1 Healthy
prover    {"status":"healthy","service":"square-prover","version":"0.1.0","checks":{"artifacts":{"ok":true,"critical":true,"latencyMs":0,"detail":"payment.wasm and payment.zkey present"}},"uptimeSeconds":26}
indexer   {"status":"healthy","service":"square-indexer","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":1},"rpc":{"ok":true,"critical":true,"latencyMs":2},"lag":{"ok":true,"critical":true,"latencyMs":1,"detail":"0 blocks behind, limit 100"},"quarantine":{"ok":true,"critical":false,"latencyMs":1,"detail":"no event set aside"}},"uptimeSeconds":11}
keeper    {"status":"healthy","service":"square-keeper","version":"0.1.0","checks":{"database":{"ok":true,"critical":true,"latencyMs":3},"rpc":{"ok":true,"critical":true,"latencyMs":4},"balance":{"ok":true,"critical":true,"latencyMs":4,"detail":"9999992487747981934720 wei of native USDC for gas"},"mirror":{"ok":true,"critical":false,"latencyMs":2,"detail":"reading the mirror an indexer writes"}},"uptimeSeconds":11}
app       HTTP 200
```

**The gate is stricter than it looks.** `/health` returns 503 when a check
marked `critical` fails, and square#147 moved two more into that set: the
indexer's `lag` and the keeper's gas `balance`. So "all healthy" now means an
indexer no further behind than `MAX_LAG_BLOCKS` and a keeper that can still pay
for a transaction, not merely two processes that answer. On a fresh local chain
the lag is zero and the anvil account is funded, which is why the timings above
are unaffected — but a stack pointed at a real chain has to catch up before
`make up` returns.

Healthy is not the same as working, so the stack was also asked to do its job.

The contracts are on the chain, not just in a file -- `eth_chainId` returns
`0x7a69`, and `eth_getCode` at the recorded addresses returns bytecode:

```
SquareJob          0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9  15242 bytes
USDC               0x5FbDB2315678afecb367f032d93F642f64180aa3   7476 bytes
IdentityRegistry   0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512    849 bytes
```

The prover produced a real Groth16 proof in 1.6 s, using the key the circuits
container built:

```
POST /prove  ->  is_compliant: true
                 violated_rules: []
                 proof.a[0]: 0x2435571a41f5de937733c211fc96a8b3b1d5748fb4e52925a0055b8d37757bf3
                 8 public signals
```

The indexer answered `/status` and was level with the chain head; the keeper
answered `/actions` with an empty journal, which is correct on a chain where no
job has been posted yet.

## Three things that were broken and are not any more

None of these Dockerfiles had been run before, and all three faults stopped a
container from starting rather than showing up as a warning.

**The images could not resolve their own dependencies.** `npm install
--install-links` copies `file:` dependencies in as real directories, and the
`npm prune --omit=dev` that followed deleted every one of them --
`node_modules/@squaresdk` came out empty, and the indexer and the keeper exited
with `Cannot find module`. Measured directly:

```
=== before prune ===        === after prune ===
core                        (empty)
data
did-resolver
observability
```

Installing production dependencies once, and adding only the compiler the build
needs, replaces the prune.

**The keeper image could not build.** Its lockfile records
`@squaresdk/indexer` as a `file:` link -- a devDependency used by one test --
and npm resolves every link in the lockfile before it decides what to omit, so
the build failed on a directory that was not in the context.

**anvil was listening on the wrong interface.** The foundry image's entrypoint
is `/bin/sh -c`, so a multi-word `command:` string reaches it as
`sh -c anvil --host 0.0.0.0 ...`, where everything after the first word becomes
`$0`, `$1` and is dropped. anvil bound `127.0.0.1`, its own health check passed
from inside the container, and nothing else on the network could reach it. The
command is a single-element list now.

## Pointing it at Arc testnet

Set `CHAIN_ID=5042002` and `RPC_URL` to the Arc endpoint, supply a funded
`KEEPER_PRIVATE_KEY`, and start without the local chain and the deployer:

```
docker compose up --wait --no-deps postgres migrate circuits prover indexer keeper app
```

**`--no-deps` and the full list are both load-bearing** (#232). Without it,
`docker compose up prover indexer keeper app` starts every `depends_on` as
well — the indexer and the keeper each declare `anvil`, `deployer` and
`migrate` — so the command that says "without the local chain and the deployer"
started both, broadcast the mock stack to the real testnet, and overwrote
`contracts/deployments/5042002.json` with mock addresses. With `--no-deps`,
compose starts only what is named, and it still orders what is named: `migrate`
runs to completion before the indexer and the keeper, and `circuits` before the
prover, which is why `postgres`, `migrate` and `circuits` are on the line.

The deployer refuses to run anywhere but the local chain now, so a hand-typed
`docker compose up` cannot reach the testnet either.

The addresses come from `contracts/deployments/5042002.json`, which compose
mounts read-only at `/deployments` and passes as `SQUARE_DEPLOYMENT_FILE` to the
indexer and the keeper on every run — the variable is set unconditionally in
`compose.yaml`, not only when you ask for it. That file is the deployment record
in version control; the services read it and nothing in this command writes to
it. A run of exactly this shape against the real chain is recorded in
[services-5042002.md](services-5042002.md).
