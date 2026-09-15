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
| `build, test, gas` | The whole Foundry suite, `forge build --sizes`, a gas report on the pull request and a coverage table on the run summary. |
| `@squaresdk/core against anvil` | The SDK drives all five settlement paths against a locally deployed stack, and the committed ABI modules match a fresh `forge build` and document every event they declare. |
| `verifies on Arc Testnet` | A proof the prover produced verifies against Arc's own `0x06`/`0x07`/`0x08`, not revm's. |
| `circuits` | `payment.circom` compiles, a proving key builds, and the whole constraint suite runs against them. The ceremony's pinned drand quicknet chain hash and group key are checked against `api.drand.sh` itself. How many tests passed is on the run summary, not in this table: a count written by hand here drifts the moment a test is added. |
| `prover (real proving key)` | The prover agrees with the circuit, and its Solidity calldata matches `snarkjs`. |
| `end-to-end (policy → proof → Arc)` | A policy, a proof built from it, and Arc accepting that proof — not from a fixture. **Not required**, see below. |
| `refuse and replay (policy → proof → anvil)` | A payment over the policy's ceiling is proved, verified, and still pays the provider nothing; a compliant payment is released once and then refused on replay — as the same bytes and as a re-randomised copy. Every refusal is asserted by the module's own reason. **Not required**, see below. |
| `six refusal scenarios (policy → proof → anvil)` | The six scenarios of #28 against a stack the run deploys itself, waiting out a real challenge window: a compliant payment is released, and a payment over the daily cap, to a blocked recipient, against a replaced policy, outside its time window, or carrying another job's proof is refused, each by the module's own reason. The same script runs on Arc; see `six refusal scenarios (Arc Testnet, funded key)` below. **Not required**, see below. |
| `services/prover (hermetic)` | The rule evaluator and the encoding with no artifacts — a contributor's `npm test`. |
| `packages/data`, `packages/hardening`, `packages/observability`, `packages/policy` | Hermetic package suites. The policy package's includes the commitment, and the local prover's circuit input and rule names, held to the prover's own construction whenever the prover is installed beside it, which the compliance path job is. |
| `packages/x402 (anvil)`, `services/indexer (anvil)`, `services/keeper (anvil)`, `services/screener (anvil)` | Against a local chain the job starts itself: anvil plus `DeployLocal.s.sol`, asserted before the suites run. `services/screener (anvil)` is **not required**, see below. |
| `app (static export)`, `site (static export)` | The reference application and the site still build. |
| `a2a` | `@squaresdk/a2a` typechecks and builds, and an agent still cannot pay itself. |
| `agent (anvil)` | `@squaresdk/agent`: the card against the schema, admission and delivery against a stub chain, and the whole loop on anvil with `DeployLocal.s.sol`: a funded job, `task/create`, `DELIVERED` by the on-chain `submit`, the crank's `finalize`, the provider's withdrawal. **Not required** until it has run without flaking. |
| `mcp (anvil)` | `@squaresdk/mcp`: the tool pool against a real MCP server over Streamable HTTP, the Square MCP server through an in-memory MCP client, and on anvil both directions at once: an agent whose capability is a bridged MCP tool, hired through `square-mcp` spawned over stdio. **Not required** until it has run without flaking. |
| `hosted (anvil)` | `@squaresdk/hosted`: sealing, the configuration, the model loop against a scripted model, the allowance over a Map of a chain, the handlers with a real MCP server; and on anvil a hosted agent taking a funded job, delegating a subtask under escrow from its own wallet within its committed policy, refused past it, with `square-hosted` sealing a key and serving a configuration. **Not required** until it has run without flaking. |
| `cli` | The resolver, the policy package and the CLI build; the CLI's exit codes are unchanged; `square policy init` and `buyers entry` without a chain. Hermetic. |
| `policy → proof → release (anvil, every surface)` | The institution's side of the compliance gate (#335, #338) on one stack the job builds itself: `DeployLocal.s.sol`, a `ComplianceModule` keyed to the proving key the job just built (`packages/policy/scripts/install-module-for-this-build.mjs`), that key's files in `services/prover/artifacts`, and the prover beside it for the lifecycle runner, asserted before anything runs. Every surface below proves in its own process from those files (#347). Then `@squaresdk/policy` makes a real proof, checks it against the key and binds it, and the module verifies it and the escrow goes to the provider, to the buyer of a sold receivable, and nowhere on a release the policy refuses; `square policy` commits, approves buyers, proves, reads back and releases; `square-mcp` keeps a hire's proof current and releases it; `square-hosted` does the same for a delegated job; and the lifecycle runner proves every release over its five paths. **Not required** until it has run without flaking. |
| `did-aip-driver (unit)` | The driver's config parsing and envelope construction. |
| `did-aip-driver image` | The container answers, and a malformed DID is still a 400 rather than a 500. On `main` it then publishes `:<version>` and `:sha-<commit>` to GHCR; the version tag is written once and never overwritten, so a version that already exists is left as it is and only the sha tag is pushed. |
| `did-aip-driver version` | Pull requests only. If anything the Dockerfile copies into the image changed (the driver's and the resolver's sources, manifests and tsconfigs), `packages/did-aip-driver/package.json` must carry a new version, because the version tag is written once and a change without a bump would never be published under a version. **Not required**, see below. |
| `local stack (make up)` | The four Dockerfiles build, the whole stack comes up on a runner, and every service answers `/health` with a passing status. Also asserts the contracts have bytecode on the chain and that the prover returns a real proof. Required since 2026-09-14, when the payload was applied with the review gate of [docs/decisions/review-gate.md](decisions/review-gate.md); its last five runs on `main` were green. |
| `pack and install (dry run)` | The thirteen `@squaresdk` packages build in dependency order and pack, each tarball carries its `dist/`, its bins, its README and the license and nothing outside `files`, none says `file:` for a sibling, and all thirteen install together into an empty project where every library imports and the four binaries answer ([docs/decisions/distribution-channel.md](decisions/distribution-channel.md)). On a `v<version>` tag the same workflow goes on to publish. **Not required**, see below. |
| `secret scan`, `forbidden strings` | No secrets, and no disclosure wording has gone missing. A red `secret scan` names the rule, the file and the line in the job log: gitleaks runs with `--verbose`, and with `--redact` beside it the value itself is never printed. It walks the git history, so the finding can sit in a commit the diff no longer shows. |

Twelve are **not** required to merge. Six of them are not required because their
red is a statement about Arc Testnet being reachable, TRM's sanctions API
answering, or a funded account, rather than about the change, and an outside
service having a bad afternoon should not block unrelated work. The other six,
`refuse and replay`, `six refusal scenarios (policy → proof → anvil)`,
`did-aip-driver version`, `policy → proof → release (anvil, every surface)`,
`services/screener (anvil)` and `pack and install (dry run)`, reach no network
and are not required only because they are new.

| Check | Why it is not required |
|---|---|
| `end-to-end (Arc Testnet)` | Resolves the permanent smoke agents against the live registry. |
| `end-to-end (policy → proof → Arc)` | New, and it reaches Arc. Promote it once it has run without flaking, the way `verifies on Arc Testnet` was. Adding it to the required set means re-applying `branch-protection.json`, in the same order: merge first, then the command. |
| `refuse and replay (policy → proof → anvil)` | New. Unlike the row above it reaches no network beyond the ptau fetch every circuit job makes, so its red is a statement about the change — which makes it the better candidate for promotion. Same rule: once it has run without flaking, merge first, then re-apply `branch-protection.json`. |
| `six refusal scenarios (policy → proof → anvil)` | New, and hermetic like the row above apart from the same ptau fetch. Promote it the same way. |
| `did-aip-driver version` | New, and hermetic: a `git diff` against the base branch and two `package.json` reads. Its red means an image input changed without a version bump. Promote it the same way once it has run a while. |
| `policy → proof → release (anvil, every surface)` | New. Hermetic apart from the ptau fetch every circuit job makes, and a Groth16 proof per release, so a long job. Promote it once it has run without flaking, merge first, then re-apply `branch-protection.json`. |
| `packages/aa (anvil)` | Named for a local chain, but `test/globalSetup.ts` calls `startAnvilFork()`, which defaults to `https://rpc.testnet.arc.io` (`scripts/fork.ts:144`) with no override and no fallback, and rethrows on failure. Arc being down would block a documentation pull request. |
| `acceptance (Arc Testnet, funded key)` | Spends real testnet gas, needs a secret, does not run on fork pull requests, and lives in its own path-filtered workflow. |
| `six refusal scenarios (Arc Testnet, funded key)` | #28's six scenarios on Arc itself. Spends real testnet USDC: the first run on Arc was 26.2M gas and cost its funder 0.588 USDC. Needs `SCENARIO_FUNDER_PRIVATE_KEY` and refuses to start without it or on a short balance. Lives in its own workflow (`arc-refusal-scenarios.yml`) and runs on pushes to `main`, by hand, and on same-repository pull requests that change the script or the workflow, one run at a time. |
| `services/screener (anvil)` | New. Like the rest of its matrix it reaches nothing but the anvil the job starts; the live tests against TRM are skipped here by design and run in the row below. Promote it the same way. |
| `pack and install (dry run)` | New, and hermetic apart from the registry fetch of the packages' own dependencies: thirteen builds, thirteen packs, one install of the tarballs. Its red means a package would ship broken. Promote it the same way once it has run a while. |
| `sanctions screening (TRM → anvil)` | #35's screener against TRM's real sanctions API, and the end-to-end run with OFAC-listed addresses against the real hook. TRM's keyless tier allows 100 requests a day and a run makes about ten, so a red can mean TRM did not answer. Lives in its own path-filtered workflow (`sanctions-screening.yml`). |

`verifies on Arc Testnet` also depends on Arc's RPC, but it is cheap, read-only
and defends a claim the README makes, so it is required. If it turns out to
flake, move it to the list above rather than deleting it.

`circuits` depends on drand the same way, for the same reason (square#260). Its
step `The drand pin, against the live chain` sends two free GETs to
`api.drand.sh` and holds the chain hash and group key pinned in
`circuits/scripts/ceremony.mjs` to what drand serves. The ceremony's beacon rests
on that pin, and a wrong one would otherwise surface only when `beacon <round>`
runs, with every contribution already made. The same rule applies: if it
flakes, move that step to a job that is not required.

## A green run that tested nothing

This is the failure this setup exists to prevent, and it is not hypothetical:
`covenant` carried 5,952 lines of tests across 33 files that CI never executed.

The shape it takes here is subtler than "no test job". The suites below guard
themselves with `skipIf`, and a job that does not satisfy the guard reports green
having executed nothing. The full inventory, because a partial one is how the
next instance of this hides:

| Guard | Suite | Runs inside | Status |
|---|---|---|---|
| `!HAVE_WASM`, `!HAVE_ZKEY` | `circuits/test/payment.test.js` | `circuits` | satisfied — the job builds the circuit and a key |
| `!HAVE_PTAU`, `!HAVE_ZKEY` | `circuits/test/ptau-adoption.test.js` | `circuits` | satisfied — the build fetches and hash-checks the ptau |
| `!HAVE_BUILD` | `circuits/test/timestamp-soundness.test.js` | `circuits` | satisfied |
| `!HAVE_BUILD` | `circuits/test/constraint-cost.test.js` (the constraint table in `circuits/README.md` and every other quoted size of the circuit, against `build/*.r1cs`; square#238) | `circuits` | satisfied — the job compiles the circuits before its tests. The table's own arithmetic is checked without a build. |
| `!LIVE` | `circuits/test/drand-beacon.test.js` (the pinned quicknet chain hash and group key against `api.drand.sh`) | `circuits` | satisfied in its own step, `The drand pin, against the live chain`, which sets `LIVE=1` and fails unless both live tests ran. Skipped by design in the job's `Tests` step, which is offline apart from the ptau (square#260). |
| `!HAVE_CIRCUIT` | `services/prover/test/circuit-agreement.test.js` | `prover (real proving key)` | satisfied |
| `!hasArtifacts` | `services/prover/test/prove-route.e2e.test.js` | `prover (real proving key)` | satisfied |
| `!HAVE_ARTIFACTS` | `services/prover/test/solidity-encoding.test.js` | `prover (real proving key)` | satisfied |
| `!HAVE_ARTIFACTS` | `services/prover/test/disclosure.test.js` (the disclosure root against a real proof's `policy_data_hash`, square#45) | `prover (real proving key)` | satisfied |
| `!hasArtifacts` | `services/prover/test/prove-backpressure.e2e.test.js` | `prover (real proving key)` | satisfied |
| `!reachable` | `services/indexer/test/{anvil,sync}.test.ts` | `services/indexer (anvil)` | satisfied — the job now starts anvil and deploys |
| `!reachable` | `services/keeper/test/{anvil,screening}.test.ts` | `services/keeper (anvil)` | satisfied — same |
| `!reachable` | `services/screener/test/anvil.test.ts` | `services/screener (anvil)` | satisfied — same |
| `!reachable` | `packages/core/test/anvil.test.ts` | `@squaresdk/core against anvil` | satisfied — that job already started one |
| `!forkUrl` | `packages/core/test/fork.test.ts` | `@squaresdk/core against anvil` | **not satisfied.** `ARC_FORK_RPC_URL` is set by no workflow, so the lifecycle has never been exercised against the real ERC-8004 registries in CI. Named on the run summary so the gap is visible. |
| `!forkUrl` | `packages/core/test/cctp.fork.test.ts` | `@squaresdk/core against anvil` | **not satisfied**, the same way: `CCTP_SEPOLIA_FORK_RPC_URL` is set by no workflow, so the burn against Circle's real `TokenMessengerV2` (square#32) runs only where someone starts a Sepolia fork. The hermetic half, `test/cctp.test.ts`, runs everywhere. |
| `!configured` | `packages/x402/test/live.test.ts` | `packages/x402 (anvil)` | **not satisfied.** Needs `ARC_TESTNET_RPC_URL` and two funded keys. |
| `!process.env.LIVE` | `packages/did-resolver/test/integration.test.ts` | `cli` | **not satisfied, by design.** `cli` is hermetic; the live reads run in `end-to-end (Arc Testnet)`. |
| `!process.env.LIVE` | `services/screener/test/live.test.ts` | `sanctions screening (TRM → anvil)` | satisfied there, which runs `test:live`. Skipped in `services/screener (anvil)` by design, which is hermetic. |
| `!live`, `!funded` | `packages/cli/test/live.test.ts` | `acceptance (Arc Testnet, funded key)` | satisfied there, which runs `npm run test:live`. The reads need only `LIVE=1`; the registration also needs `SQUARE_PRIVATE_KEY`, so it runs on pushes to `main` and same-repository pull requests and skips itself, named on the run summary, where the secret is absent. The job is path-filtered and not required. Skipped in `cli` by design, which is hermetic. |
| `!process.env.SMOKE` | `packages/cli/test/smoke.test.ts` | `end-to-end (Arc Testnet)` | satisfied there, which runs `npm run test:smoke`. Skipped in `cli` by design. |
| `!("stack" in ready)`, `notReady !== null` | `packages/policy/test/anvil.test.ts`, `packages/cli/test/policy.anvil.test.ts`, `packages/mcp/test/compliance.test.ts`, `packages/hosted/test/compliance.test.ts` | `policy → proof → release (anvil, every surface)` | satisfied — the job installs the module and copies the key's files the suites prove with, and asserts both before the suites run. In `mcp (anvil)`, `hosted (anvil)` and `cli` the two compliance suites skip by design: those stacks hold no module. |
| `!proverInstalled` | `packages/policy/test/commitment.test.ts` (the cross-check against the prover), `packages/policy/test/local-prover.test.ts` (the local prover's circuit input and rule names against the prover's) | `packages/policy`, `policy → proof → release` | satisfied in the second, where the prover is installed; skipped in the first, by design. |
| `!haveArtifacts` | `packages/policy/test/local-prover.test.ts` (a real proof made in the test's process, checked against `payment_vk.json`, and a verification key from another key refused) | `policy → proof → release` | satisfied — the job copies `payment.wasm`, `payment.zkey` and `payment_vk.json` to `services/prover/artifacts`. Skipped in `packages/policy`, by design, which builds no circuit. |

Further guards are *inverse*: measured on 2026-09-15, eight in `circuits/test`
and five in the prover, one beside each guarded prover suite above
(`circuit-agreement`, `prove-route.e2e`, `solidity-encoding`, `disclosure`,
`prove-backpressure.e2e`). Each is a single test titled `skipped: …` that runs
only when the artifact is **absent**, to say so out loud. Seeing one skipped is
the correct state, and in `prover (real proving key)` it is the only skip allowed
(below).

Measured on 2026-09-07, with the artifacts moved aside and the suites unchanged,
on a clean checkout after `npm ci`. The figure in brackets is what vitest
**collected**, not what ran:

```
circuits   npm test →  4 passed | 45 skipped (49 collected)   exit 0
prover     npm test → 63 passed |  6 skipped (69 collected)   exit 0
```

Both lines are an observation from that date rather than a current count, and
the same two lines head
[.github/workflows/circuits.yml](../.github/workflows/circuits.yml). A rerun
collects whatever the suites hold on the day; the run summary is the live
number.

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
substitute for `prover (real proving key)`, which runs what the hermetic job
skips. On 2026-09-15 that was eleven tests in four suites that need a proving key
(`prove-route.e2e`, `solidity-encoding`, `disclosure`, `prove-backpressure.e2e`)
and ten in `circuit-agreement.test.js` that need the compiled circuit. The figure
is not kept here to be checked by hand: that job's `Every guarded test ran` step,
`.github/scripts/vitest-unexpected-skips.mjs`, fails when a test skips there that
is not a `skipped: …` placeholder (square#259). This file said "five" while there
were seven.

## Documented events

`@squaresdk/core against anvil` runs two checks in a row on the committed ABI
modules, and the order is what makes the second one worth anything:

```bash
npm run generate:abi
git diff --exit-code -- src/abi
npm run check:events
```

The first two prove the committed ABI modules are the ones a fresh `forge build`
produces. Only then is the third worth running, because the event names it reads
are the contracts' own rather than whatever was last committed by hand.

`check:events` is `packages/core/scripts/check-events-documented.mjs`. It reads
every event name out of `packages/core/src/abi/*.ts` and fails when one of them
appears nowhere in
[docs/design/storage-and-events.md](design/storage-and-events.md). That document
is normative: `services/indexer/README.md` says the reducer does what it
specifies, so an event it never mentions is a hole in the specification, and
[#167](https://github.com/wienerlabs/square/issues/167) found seven of them at
once. Adding an event to a contract now fails the run until the document names
it.

`erc20.ts` is skipped. It is a hand-written interface for a token this
repository does not ship, so its `Transfer` has no place in a document about
Square's own storage.

## Pinned tooling

| | Version | Why pinned |
|---|---|---|
| `circom` | `v2.2.3` | The compiler decides what the constraint tests are testing. Installed from the iden3 release and checked against sha256 `85342c7f…fe53a3` — see [.github/actions/circom](../.github/actions/circom/action.yml). |
| Node | `22` | Matches the rest of the workflows. |
| `solc` | `0.8.28` | Already pinned in [foundry.toml](../contracts/foundry.toml) with the optimizer settings, so bytecode is reproducible. |
| `gitleaks` | `v8.28.0` | The binary that decides whether a secret is in the tree. Downloaded from the gitleaks release and checked against sha256 `a65b5253…a840eb` from the release's checksums file before it is extracted; see [security.yml](../.github/workflows/security.yml). |

`circom` is a Rust binary and building it from source takes minutes, so CI takes
the iden3 release binary — and checks it, because an unverified download means
whoever can answer for github.com chooses the compiler that produces this
project's proving key.

The 19 MB phase-1 powers of tau is cached, keyed on `fetch-ptau.mjs` because
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

Nothing in the required set needs any of these. All are optional and all are
read only by jobs already restricted to this repository.

| Name | Kind | Used by | Effect when unset |
|---|---|---|---|
| `SQUARE_PRIVATE_KEY` | secret | `acceptance (Arc Testnet, funded key)` | The reads and the `eth_call` dry run still execute; the registration suite skips itself and the run summary names it. |
| `SCENARIO_FUNDER_PRIVATE_KEY` | secret | `six refusal scenarios (Arc Testnet, funded key)` | The script refuses to start and says why, so the run is red rather than green over nothing. It is the account that deploys, owns, funds and cranks the run; it needs roughly the gas of one run plus the jobs' budgets, and the script checks that before it spends anything. |
| `ARC_VERIFIER_ADDRESS` | variable | `verifies on Arc Testnet` | The deployed verifier is not checked. The state-override check, which needs no deployment, still runs. |
| `NPM_TOKEN` | secret | `publish to npm` (a `v<version>` tag) | The job says the token is not set and publishes nothing; the dry run before it still runs. It is the token of the account that owns the `@squaresdk` scope, which [docs/decisions/distribution-channel.md](decisions/distribution-channel.md) leaves to the project to name. |

`ARC_VERIFIER_ADDRESS` is a variable rather than a line in the workflow because
the address is temporary: [#16](https://github.com/wienerlabs/square/issues/16)
produces a new proving key, and therefore a new verifier at a new address.

### Fork pull requests

`acceptance (Arc Testnet, funded key)` and `six refusal scenarios (Arc Testnet,
funded key)` are the jobs that need a secret, and both are guarded so they do
not run on a pull request from a fork:

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
site (static export)
a2a
cli
did-aip-driver (unit)
did-aip-driver image
local stack (make up)
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

`required_pull_request_reviews` is the review gate of
[docs/decisions/review-gate.md](decisions/review-gate.md): a pull request that
touches `contracts/` or `circuits/` needs an approving review from a code owner
in `.github/CODEOWNERS` who did not author it; any other pull request needs
none. After applying the payload, confirm both: a documentation pull request
shows no review requirement, a contracts pull request shows one.

Renaming a job renames its check. A required check that no longer reports blocks
every merge, so the list above and the job names in the workflows have to move
together — including the `matrix.package` entries in `packages.yml`, whose check
names are the matrix values.
