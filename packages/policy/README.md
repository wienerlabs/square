# @squaresdk/policy

The institution's side of the compliance gate ([#335][i335], [#338][i338]):
the spending policy it commits to `PolicyRegistry`, the proof that a release
fits that policy, and the duty of keeping that proof bound to each job until
the job is released. Built on `@squaresdk/core`; the proof is made in the
institution's own process, from the circuit's files
([docs/decisions/prover-trust-boundary.md](../../docs/decisions/prover-trust-boundary.md)).

[i335]: https://github.com/wienerlabs/square/issues/335
[i338]: https://github.com/wienerlabs/square/issues/338

## The policy

A policy is a JSON file in the prover's own vocabulary (`POST /prove`,
`services/prover/src/openapi.js`), the request's policy half verbatim:

```json
{
  "policy_id": "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
  "policy_salt": "2743…(a decimal field element of at least 2^128)",
  "operator_id": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "max_daily_spend": "100000000",
  "max_per_transaction": "10000000",
  "allowed_endpoint_categories": ["text.summarize", "research.brief"],
  "blocked_addresses": [],
  "token_whitelist": ["0x3600000000000000000000000000000000000000"],
  "time_restrictions": [{ "allowed_days": ["monday", "friday"], "allowed_hours_start": 9, "allowed_hours_end": 17 }]
}
```

`policy_salt` is the secret: every leaf salt derives from it and whoever
holds it can open the committed values. `newPolicy` draws it, `parsePolicy`
refuses what the prover would refuse, `redactPolicy` blanks it for a log.
The file stays with the institution and is proved where it is read
([#347](https://github.com/wienerlabs/square/issues/347)): `createLocalProver`
never sends it anywhere.

`policyCommitment(policy)` is the commitment `PolicyRegistry.commitmentOf`
holds and public signal 1 of every proof: eight values behind salts derived
from the secret, hashed with their position, and a Poseidon root
(square#45). The construction exists in the circuit, in the prover and here,
and `test/commitment.test.ts` holds this one to the prover's whenever the
prover is installed beside it. The hash is `poseidon-lite`, small enough for
a page and bit-for-bit circomlibjs's.

## The proof, and why it is a duty

A proof binds to the release as the chain will make it: the payee the hook
resolves, the net after fees and after a decided dispute's split, the day's
counter and the clock within the module's tolerance. All four move between
funding and release, so the proof cannot be a step of funding; it is kept
current on every open job and the job is cranked once its window closes
([docs/decisions/proof-freshness.md](../../docs/decisions/proof-freshness.md)).

```ts
import { ComplianceDuty, parsePolicy } from "@squaresdk/policy";
import { createLocalProver } from "@squaresdk/policy/node";

const prover = createLocalProver({ artifacts: "/path/to/artifacts" }); // payment.wasm, payment.zkey, payment_vk.json
const duty = new ComplianceDuty({
  client,                                              // a SquareClient whose wallet is the jobs' client
  policy: parsePolicy(JSON.parse(readFileSync("policy.json", "utf8"))),
  prover,
  onEvent: (event) => console.error(event),
});
duty.track(jobId, "text.summarize");                   // when the job is funded, with the capability it bought
await duty.run(signal, { intervalMs: 15_000 });        // for as long as the process lives
await prover.close();                                  // snarkjs keeps worker threads until then
```

## The proof, made here

`createLocalProver` builds the circuit input and names the rules a refused
release broke the way `services/prover` does, proves with snarkjs, and checks
every proof against `payment_vk.json` before returning it, so files from two
different keys are named here instead of refused at release.
`test/local-prover.test.ts` holds the input and the rule names to the prover's
own functions whenever the prover is installed beside this package, and makes a
real proof when the files are there. One proof took 755 to 893 ms and at most
678 MB on an arm64 Mac; the files are about 10 MB. The directory must hold the
key the module on the chain is keyed to.

`createProverClient({ url })` is still here, for a page that cannot prove
itself: the app's job page sends the policy to the prover at
`NEXT_PUBLIC_PROVER_URL`, whose operator sees it.

Each tick, per tracked job: `releaseFacts` reads what the release binds to,
`proofState` compares it with the proof on the job, `bindComplianceProof`
proves and rebinds when they differ or the proof aged past half the
tolerance, and once the window has closed (or the arbiters have decided) the
duty cranks. A proof the circuit marks non-compliant is reported with the
rules it broke; since a job with no proof does not settle (square#382), the
duty binds the refusal once it is the mandate's last word, a rule that says
the same tomorrow or a job about to expire, and the release returns the net
to this wallet (`refusal-bound`, then `released` with `verified: false`); a
refusal the day's counter or the policy's hours can clear is waited out
(`refusalIsTransient`). A job funded under a policy the client has since
replaced is proved against the commitment pinned at funding
(`releaseFacts.pinnedCommitment`), and a file that computes the newer one is
refused as `policy-pinned`, naming the older file. Everything is on the chain
or in the policy; the duty remembers only which jobs it watches.

On a hook that screens ([sanctions-screening.md](../../docs/decisions/sanctions-screening.md)),
the payee's record decides the release as much as the proof does: the hook
pays nothing to a payee without a fresh, clean one, and the net goes back to
the client. So before it cranks the duty reads the record (`SquareClient.screeningOf`).
Cleared, it cranks; a fresh record that says designated, it cranks too, since
that refusal is the outcome screening exists for; missing or stale, it asks
the `screener` it was given for a fresh one and reads again, and with none, or
still no record, it **holds** the job: nothing is sent, the tick's `held` list
and a `held` event say why, once per reason, and the next tick reads again.
The `released` event carries `payeeCleared`, what the hook's `ScreeningChecked`
said. Pass `screener: createScreenerClient({ url })` from `@squaresdk/core`, the
same one the client funds through.

One-shot use is the same call: `bindComplianceProof({ client, policy, prover, jobId, category })`.

## The stack the tests run against

`DeployLocal.s.sol` deploys `src/Groth16Verifier.sol`, whose constants come
from one particular proving key, and `circuits/scripts/build.mjs` draws
fresh entropy on every build; so a local module and a local prover agree only
if the module is keyed to the prover's key. `scripts/install-module-for-this-build.mjs`
does that on a running anvil: it compiles the repository's verifier with the
constants of `services/prover/artifacts/payment_vk.json`, deploys it and a
`ComplianceModule`, registers the module as the registry's spender and
installs it on the hook.

```bash
anvil --port 8545 --chain-id 31337 &
(cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast)
(cd circuits && npm run build && cp build/payment.zkey build/payment_vk.json ../services/prover/artifacts/ && cp build/payment_js/payment.wasm ../services/prover/artifacts/)
(cd packages/policy && npm run install-module)
npm run test:anvil                                      # here, and in packages/cli, packages/mcp, packages/hosted
```

Every suite that needs the stack skips itself, with the reason, when anvil,
the key's files or the module is missing (`test/helpers/stack.ts`). The suites
prove in their own process from `services/prover/artifacts`, the directory the
module was keyed from. `ANVIL_RPC_URL`, `SQUARE_PROVER_ARTIFACTS` and
`SQUARE_DEPLOYMENT_FILE` point them elsewhere. The other
packages' anvil suites keep running against a stack without a module, where
nothing is proof gated.
