# Continuous integration

What runs on a pull request, what it proves, and what has to be configured for
the parts that cannot run on their own.

## The checks

All of these run on every pull request. None is filtered by path: a required
status check that a path filter skips never reports at all, and GitHub blocks
the merge waiting for a run that will never happen. Pushes to `main` keep their
path filters, where the failure mode is a wasted minute rather than a stuck
pull request.

| Check | What a green run means |
|---|---|
| `build, test, gas` | 111 Foundry tests, `forge build --sizes`, a gas report on the pull request and a coverage table on the run summary. |
| `@squaresdk/core against anvil` | The SDK drives all five settlement paths against a locally deployed stack. |
| `verifies on Arc Testnet` | A proof the prover produced verifies against Arc's own `0x06`/`0x07`/`0x08`, not revm's. |
| `circuits` | `payment.circom` compiles, a proving key builds, and 49 constraint tests ran against them. |
| `prover (real proving key)` | The prover agrees with the circuit, and its Solidity calldata matches `snarkjs`. |
| `services/prover (hermetic)` | The rule evaluator and the encoding with no artifacts — a contributor's `npm test`. |
| `packages/data`, `packages/hardening`, `packages/observability` | Hermetic package suites. |
| `packages/x402 (anvil)`, `services/indexer (anvil)`, `services/keeper (anvil)` | Against a local chain the job starts itself: anvil plus `DeployLocal.s.sol`, asserted before the suites run. |
| `app (static export)` | The reference application still builds. |
| `a2a` | `@squaresdk/a2a` typechecks and builds, and an agent still cannot pay itself. |
| `cli` | The resolver and the CLI build; the CLI's exit codes are unchanged. Hermetic. |
| `did-aip-driver (unit)` | The driver's config parsing and envelope construction. |
| `did-aip-driver image` | The container answers, and a malformed DID is still a 400 rather than a 500. |
| `secret scan`, `forbidden strings` | No secrets, and no disclosure wording has gone missing. |

Three are **not** required to merge. Each one's red is a statement about Arc
Testnet being reachable, or about a funded account, rather than about the change,
and a young testnet having a bad afternoon should not block unrelated work.

| Check | Why it is not required |
|---|---|
| `end-to-end (Arc Testnet)` | Resolves the permanent smoke agents against the live registry. |
| `packages/aa (anvil)` | Named for a local chain, but `test/globalSetup.ts` calls `startAnvilFork()`, which defaults to `https://rpc.testnet.arc.io` (`scripts/fork.ts:144`) with no override and no fallback, and rethrows on failure. Arc being down would block a documentation pull request. |
| `acceptance (Arc Testnet, funded key)` | Spends real testnet gas, needs a secret, does not run on fork pull requests, and lives in its own path-filtered workflow. |

`verifies on Arc Testnet` also depends on Arc's RPC, but it is cheap, read-only
and defends a claim the README makes, so it is required. If it turns out to
flake, move it to the list above rather than deleting it.

## A green run that tested nothing

This is the failure this setup exists to prevent, and it is not hypothetical:
`covenant` carried 5,952 lines of tests across 33 files that CI never executed.

The shape it takes here is subtler than "no test job". Twelve suites guard
themselves with `skipIf`, and a job that does not satisfy the guard reports green
having executed nothing. The full inventory, because a partial one is how the
next instance of this hides:

| Guard | Suite | Runs inside | Status |
|---|---|---|---|
| `!HAVE_WASM`, `!HAVE_ZKEY` | `circuits/test/payment.test.js` | `circuits` | satisfied — the job builds the circuit and a key |
| `!HAVE_PTAU`, `!HAVE_ZKEY` | `circuits/test/ptau-adoption.test.js` | `circuits` | satisfied — the build fetches and hash-checks the ptau |
| `!HAVE_BUILD` | `circuits/test/timestamp-soundness.test.js` | `circuits` | satisfied |
| `!HAVE_CIRCUIT` | `services/prover/test/circuit-agreement.test.js` | `prover (real proving key)` | satisfied |
| `!hasArtifacts` | `services/prover/test/prove-route.e2e.test.js` | `prover (real proving key)` | satisfied |
| `!HAVE_ARTIFACTS` | `services/prover/test/solidity-encoding.test.js` | `prover (real proving key)` | satisfied |
| `!reachable` | `services/indexer/test/{anvil,sync}.test.ts` | `services/indexer (anvil)` | satisfied — the job now starts anvil and deploys |
| `!reachable` | `services/keeper/test/anvil.test.ts` | `services/keeper (anvil)` | satisfied — same |
| `!reachable` | `packages/core/test/anvil.test.ts` | `@squaresdk/core against anvil` | satisfied — that job already started one |
| `!forkUrl` | `packages/core/test/fork.test.ts` | `@squaresdk/core against anvil` | **not satisfied.** `ARC_FORK_RPC_URL` is set by no workflow, so the lifecycle has never been exercised against the real ERC-8004 registries in CI. Named on the run summary so the gap is visible. |
| `!configured` | `packages/x402/test/live.test.ts` | `packages/x402 (anvil)` | **not satisfied.** Needs `ARC_TESTNET_RPC_URL` and two funded keys. |
| `!process.env.LIVE` | `packages/did-resolver/test/integration.test.ts` | `cli` | **not satisfied, by design.** `cli` is hermetic; the live reads run in `end-to-end (Arc Testnet)`. |

Four further guards are *inverse* — `skipIf(HAVE_BUILD)` and the prover's three
`skipIf(HAVE_*)`. They fire only when the artifact is **absent** and exist to say
so out loud. Seeing one skipped is the correct state.

Measured, with the artifacts moved aside and the suites unchanged, on a clean
checkout after `npm ci`:

```
circuits   npm test →  4 passed | 45 skipped (49)   exit 0
prover     npm test → 63 passed |  6 skipped (69)   exit 0
```

And measured on `main` before this branch, where the `(anvil)` jobs were named
for a chain they never started:

```
services/indexer (anvil)  →  7 passed | 3 skipped (10)   exit 0
services/keeper  (anvil)  →  9 passed | 1 skipped (10)   exit 0
```

So, two mechanisms:

1. **The job fails before vitest starts if what the tests need is not there.**
   `circuits` and `prover (real proving key)` check for the compiled wasm and the
   proving key; the `(anvil)` jobs check that anvil answers on `127.0.0.1:8545`
   and that `contracts/deployments/31337.json` exists — both, because
   `localDeployment()` reads that file and only `--broadcast` writes it. With the
   preconditions present the guards are false and the tests cannot skip. **This
   is the gate.**
2. **Every job that can, prints what ran.** A vitest job writes a JSON report and
   the run summary names how many tests passed and the full name of every test
   that was skipped anyway. This is **visibility, not a gate**:
   `.github/scripts/vitest-summary.mjs` never exits non-zero and every call sits
   under `if: always()`, deliberately, so it cannot mask the real failure. It is
   what makes a guard that stops being satisfied — like `!forkUrl` above —
   visible without reading logs.

   It runs in `circuits`, `prover (real proving key)`, `did-aip-driver (unit)`,
   `@squaresdk/core against anvil`, the four `(anvil)` matrix jobs, and
   `acceptance (Arc Testnet, funded key)`. The rest do not have one.

`services/prover (hermetic)` in `packages.yml` is the no-artifacts run and is
kept: it is the contributor's `npm test` and it should stay green. It is not a
substitute for `prover (real proving key)`, which runs the five tests the
hermetic job skips.

## Pinned tooling

| | Version | Why pinned |
|---|---|---|
| `circom` | `v2.2.3` | The compiler decides what the constraint tests are testing. Installed from the iden3 release and checked against sha256 `85342c7f…fe53a3` — see [.github/actions/circom](../.github/actions/circom/action.yml). |
| Node | `22` | Matches the rest of the workflows. |
| `solc` | `0.8.28` | Already pinned in [foundry.toml](../contracts/foundry.toml) with the optimizer settings, so bytecode is reproducible. |

`circom` is a Rust binary and building it from source takes minutes, so CI takes
the iden3 release binary — and checks it, because an unverified download means
whoever can answer for github.com chooses the compiler that produces this
project's proving key.

The 9.5 MB phase-1 powers of tau is cached, keyed on `fetch-ptau.mjs` because
that file holds the adoption record, so adopting a different powers of tau
misses the cache instead of reusing the old file. `fetch-ptau.mjs` re-verifies
the bytes on every run either way, which is what makes caching a downloaded
trust anchor safe at all.

### Actions are pinned to commits

Every `uses:` in `.github/workflows/` names a 40-character commit SHA with the
release in a trailing comment, not a moving tag. `actions/checkout@v4` is a
branch that its owner can repoint at any time; a workflow that trusts it is
trusting whoever holds that repository, continuously, to a token that in this
repository can write to GHCR. It is the same argument the circom action makes
for pinning the compiler, and it applies at least as strongly to the thing that
runs before the compiler does.

Renewing a pin is deliberate work: read what changed, then move the SHA and the
comment together.

## Coverage

`forge coverage --ir-minimum --no-match-coverage "(script|test)/"`, written to
the run summary. `--ir-minimum` is needed because coverage disables the
optimizer to keep the source mapping honest and `SquareJob` then fails to
compile with "stack too deep". Scripts and mocks are excluded: neither has
assertions to cover, and counting them reports the contracts that ship as lower
than they are.

No threshold is enforced. The issue asked for coverage, not for a gate, and a
number chosen here would be an invented one.

## Secrets and variables

Nothing in the required set needs either. Both are optional and both are read
only by jobs already restricted to this repository.

| Name | Kind | Used by | Effect when unset |
|---|---|---|---|
| `SQUARE_PRIVATE_KEY` | secret | `acceptance (Arc Testnet, funded key)` | The reads and the `eth_call` dry run still execute; the registration suite skips itself and the run summary names it. |
| `ARC_VERIFIER_ADDRESS` | variable | `verifies on Arc Testnet` | The deployed verifier is not checked. The state-override check, which needs no deployment, still runs. |

`ARC_VERIFIER_ADDRESS` is a variable rather than a line in the workflow because
the address is temporary: [#16](https://github.com/wienerlabs/square/issues/16)
produces a new proving key, and therefore a new verifier at a new address.

### Fork pull requests

`acceptance (Arc Testnet, funded key)` is the only job that needs a secret, and
it is guarded so it does not run on a pull request from a fork:

```yaml
if: >-
  github.event_name != 'pull_request' ||
  github.event.pull_request.head.repo.full_name == github.repository
```

A fork's `pull_request` run gets no secrets, so the job would fail rather than
skip, and a first-time contributor would see a red check they have no way to
fix. Everything else — including both read-only Arc checks — runs on forks.

The gas comment in `contracts.yml` is subject to the same limit from the other
side: a fork's `pull_request` run gets a read-only token whatever the
`permissions:` block says, and `createComment` would return 403 and fail the
step — and `build, test, gas` is required, so an outside contributor would face
a red check they could not fix. The comment step is therefore guarded on the
head repository, and a separate step writes the same table to
`$GITHUB_STEP_SUMMARY` on **every** run, so the report exists whether or not the
comment does.

## Branch protection

Protection is a repository setting, not a file, so it is recorded here rather
than being something CI can assert. `main` requires these checks:

```
build, test, gas
@squaresdk/core against anvil
verifies on Arc Testnet
circuits
prover (real proving key)
services/prover (hermetic)
packages/data
packages/hardening
packages/observability
packages/x402 (anvil)
services/indexer (anvil)
services/keeper (anvil)
app (static export)
a2a
cli
did-aip-driver (unit)
did-aip-driver image
secret scan
forbidden strings
```

**Apply this only after the pull request that introduces these checks has
merged.** Seven of the contexts below are produced by jobs that do not exist on
`main` until then, and a required check that never reports blocks every merge —
recovering from that needs an administrator to undo the protection.

```bash
gh api -X PUT repos/wienerlabs/square/branches/main/protection \
  --input docs/ci/branch-protection.json
```

`strict: true` means a branch has to be up to date with `main` before it can
merge, so the checks that gate a merge are the ones that ran against the code
that will actually land.

Renaming a job renames its check. A required check that no longer reports blocks
every merge, so the list above and the job names in the workflows have to move
together — including the `matrix.package` entries in `packages.yml`, whose check
names are the matrix values.
