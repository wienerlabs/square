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
| `packages/x402 (anvil)`, `packages/aa (anvil)`, `services/indexer (anvil)`, `services/keeper (anvil)` | Against a local chain. |
| `app (static export)` | The reference application still builds. |
| `a2a` | `@squaresdk/a2a` typechecks and builds, and an agent still cannot pay itself. |
| `cli` | The resolver and the CLI build; the CLI's exit codes are unchanged. Hermetic. |
| `did-aip-driver (unit)` | The driver's config parsing and envelope construction. |
| `did-aip-driver image` | The container answers, and a malformed DID is still a 400 rather than a 500. |
| `secret scan`, `forbidden strings` | No secrets, and no disclosure wording has gone missing. |

Two run on every pull request but are **not** required to merge. Each one's red
is a statement about Arc Testnet being reachable rather than about the change,
and a young testnet having a bad afternoon should not block unrelated work.

| Check | Why it is not required |
|---|---|
| `end-to-end (Arc Testnet)` | Resolves the permanent smoke agents against the live registry. |
| `acceptance (Arc Testnet, funded key)` | Spends real testnet gas, needs a secret, and does not run on fork pull requests at all. |

`verifies on Arc Testnet` also depends on Arc's RPC, but it is cheap, read-only
and defends a claim the README makes, so it is required. If it turns out to
flake, move it to the list above rather than deleting it.

## A green run that tested nothing

This is the failure this setup exists to prevent, and it is not hypothetical:
`covenant` carried 5,952 lines of tests across 33 files that CI never executed.

The shape it takes here is subtler than "no test job". Several suites guard
themselves with `skipIf`:

- `circuits/test/*` skips every constraint test when `build/payment_js/payment.wasm`
  is absent, which is correct on a machine without `circom`.
- `services/prover/test/{circuit-agreement,solidity-encoding,prove-route.e2e}.test.js`
  skip when there is no proving key to prove against.

A runner that installs neither reports green having executed almost nothing.
Measured on this repository, with the artifacts moved aside:

```
circuits   npm test →  8 passed | 41 skipped (49)   exit 0
prover     npm test → 63 passed |  6 skipped (69)   exit 0
```

So:

1. `circuits` and `prover (real proving key)` install a pinned `circom`, build
   the circuit and a development proving key, and **fail the job if the
   artifacts are not on disk** before vitest starts. With the files present the
   guards are false and the real tests cannot be skipped.
2. Every vitest job writes a JSON report and prints, on the run summary, how
   many tests passed and **the full name of every test that was skipped**. A
   suite that starts skipping is visible without reading logs.

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
side: a fork's token is read-only whatever the `permissions:` block says, so the
report goes to the run summary there instead.

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
packages/aa (anvil)
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

Applied with:

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
