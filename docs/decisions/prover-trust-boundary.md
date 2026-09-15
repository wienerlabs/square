# The proof is made where the policy lives

**Status:** decided and implemented for [#347][i347]. Binds `@squaresdk/policy`
(`createLocalProver`, from `@squaresdk/policy/node`), `square policy prove` and
`watch`, `square-mcp` and `square-hosted`. The prover service stays, for the
app's job page and for development. Bears on [#336][i336], which chooses where
the project's services run.

[i16]: https://github.com/wienerlabs/square/issues/16
[i236]: https://github.com/wienerlabs/square/issues/236
[i336]: https://github.com/wienerlabs/square/issues/336
[i337]: https://github.com/wienerlabs/square/issues/337
[i347]: https://github.com/wienerlabs/square/issues/347

## The question

A proof that a release fits a policy takes the whole policy as circuit input:
the two ceilings, the blocked addresses, the categories, the time window and
`policy_salt`. The eight leaf salts derive from `policy_salt`, so whoever holds
it can open every value the on-chain commitment hides
([public-daily-ceiling.md](public-daily-ceiling.md)).

Until this decision the code and the hosting plan disagreed about where that
input goes.

- **The code assumed the institution's own prover.** `proveRequest` serialised
  the policy, salt included, into `POST /prove`, and `createProverClient` said
  "the prover is the institution's own".
- **The hosting plan counted the prover as the project's.**
  [service-hosting.md](service-hosting.md) listed it among the four services
  the project would run, `compose.yaml` starts it with the stack, and #336
  chooses a provider for it.
- **The prover has no authentication.** It has a CORS list and nothing else.
  Its capacity ceiling ([#236][i236]) answers 503 to everyone at once, so one
  institution's load delays another's proof, and a late proof misses its
  window.

Both could not be true. Against the hosted plan, every institution's mandate
passed through the project's server, and "private spending mandate" meant
private from the chain and not from the operator.

## The decision

**The proof is made in the process that holds the policy.** For the
institution's own tools, the policy never crosses a process boundary.

- **`createLocalProver({ artifacts })`** in `@squaresdk/policy/node` reads
  `payment.wasm`, `payment.zkey` and `payment_vk.json` from a directory.
- It builds the circuit input and names the broken rules the way
  `services/prover` does. `test/local-prover.test.ts` holds both to the
  prover's own `buildCircuitInput` and `evaluateRules` whenever the prover is
  installed beside the package.
- It proves with snarkjs and checks every proof against `payment_vk.json`
  before returning it. That file is the one
  `scripts/install-module-for-this-build.mjs` keys a module to, so a zkey from
  another key is named at proving time. Otherwise the module would refuse it at
  release without a reason.
- It implements the same `Prover` interface the duty and
  `bindComplianceProof` already take, so nothing downstream changed.

The three tools take a directory instead of a URL:

| Surface | Before | Now |
|---|---|---|
| `square policy prove`, `watch` | `--prover <url>` | `--artifacts <dir>`, or `SQUARE_PROVER_ARTIFACTS` |
| `square-mcp` | `SQUARE_PROVER_URL` | `SQUARE_PROVER_ARTIFACTS` |
| `square-hosted` | `compliance.proverUrl` in the config | `SQUARE_PROVER_ARTIFACTS` |

snarkjs keeps worker threads between proofs, and a process that proved once
does not exit while they run. `LocalProver.close()` stops them. The CLI calls
it when a command ends, and `square-mcp` calls it when its client disconnects.

## Who sees the policy

| Surface | Where the policy is | Where the proof is made | Who else sees the policy |
|---|---|---|---|
| `square policy` | the file on the machine | the CLI's process | nobody |
| `square-mcp` | `SQUARE_POLICY_FILE` | the server's process | nobody |
| `square-hosted` | `compliance.policyFile`, beside the config | the host's process | whoever operates the host: the institution when it runs its own, the platform when the platform runs it, which already holds the agent's wallet |
| app, job page | the browser's storage | the prover at `NEXT_PUBLIC_PROVER_URL` | that prover's operator |
| lifecycle runner (development) | `LIFECYCLE_POLICY_FILE` | the prover at `LIFECYCLE_PROVER_URL` | that prover's operator |

The chain sees what it saw before:

- the commitment and the daily limit `setPolicy` publishes;
- the eight public signals of each proof: compliant or not, the commitment,
  the payee, the amount, the token, the day's counter, the timestamp and the
  receipt hash.

## What it costs

Measured on this build's key (`zkey` sha256 `e41a9a13…`), Node 26 on an arm64
macOS machine, three runs:

| | |
|---|---|
| `payment.wasm` | 5,239,977 bytes |
| `payment.zkey` | 5,209,750 bytes |
| `payment_vk.json` | 4,206 bytes |
| proving | 755 to 893 ms |
| the check against `payment_vk.json` | 12 to 20 ms |
| peak resident memory, one proof and its check | 632 to 678 MB |

## The files are the key

The directory has to hold the key the module on the chain was keyed to. Any
other key's proofs fail the pairing, and the per-proof check says so before the
proof leaves the process.

- **On a local stack:** `circuits: npm run build` draws a fresh phase-2 key on
  every build, and `install-module-for-this-build.mjs` keys the module to the
  `payment_vk.json` beside it. The suites prove from that same directory.
- **On Arc:** the files are the ceremony's ([#16][i16]), and the verifier keyed
  to them is [#337][i337]. Neither exists yet. Until they do, no module on the
  shared stack has a key an institution could prove against.

## The options not taken

- **Proving in the browser.** The app keeps the policy in the browser's storage,
  so this is the same decision for the app. It was not built here. The page
  would download about 10 MB of circuit files and spend about 650 MB proving,
  and that has to be measured in a browser before it is chosen. Until then the
  job page proves at `NEXT_PUBLIC_PROVER_URL`, and the app's README says the
  policy's secret is sent there.
- **A hosted prover with a trust statement.** An API key per institution, a
  promise that request bodies are not logged, and a README sentence that the
  mandate is open to the operator. The operator would still see every mandate,
  and nothing a caller can check shows that the promise was kept. It was the
  cheapest option and the weakest one, and the tools no longer need it.

## What this does not do

- **The app's job page still sends the policy to a prover.** Its operator sees
  the mandate of every institution that binds a proof from that page.
- **It does not distribute the files.** A local build produces them. The
  ceremony's files, the ones Arc would need, are not published yet ([#16][i16]).
- **It adds nothing to `services/prover`.** It still has no authentication. It
  serves the app and development, and `compose.yaml` runs it beside the local
  stack. For [#336][i336]: a prover the project hosts would serve the app's job
  page, not the institutions' tools, and whoever runs it sees the mandate of
  every policy sent to it.
- **The circuit input now exists in three places:** the prover, the circuit's
  test helpers and this package. Each is held to the prover's by a test.
