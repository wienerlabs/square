# @squaresdk/prover

HTTP service wrapping snarkjs to generate Groth16 proofs for the
payment-compliance circuit.

Carried over from `aperture/services/prover-service` under [#4][i4], with the
compliance-violation log leak fixed on the way in — see
[What changed from aperture](#what-changed-from-aperture).

[i4]: https://github.com/wienerlabs/square/issues/4

## Endpoints

| | |
|---|---|
| `GET /health` | Health with the artifact check, from `@squaresdk/observability`. |
| `GET /metrics` | Prometheus exposition: proof duration histogram, failures by reason, process metrics. |
| `GET /version` | Service, version, commit and Node version. |
| `GET /api-docs.json` | OpenAPI 3.0 spec for the two endpoints below it. |
| `POST /prove` | Generate a proof for one payment. |

`POST /prove` returns 200 with a proof whether or not the payment is compliant:
the circuit proves that the six policy checks were *performed*, not that they
passed. Read `is_compliant`, and when it is false read `violated_rules`.

## Running it

```bash
npm install
PROVER_ARTIFACTS_DIR=/path/to/artifacts npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `PROVER_SERVICE_PORT` | `3003` | Listen port. |
| `PROVER_ARTIFACTS_DIR` | `./artifacts` | Directory holding `payment.wasm` and `payment.zkey`. |
| `CORS_ORIGINS` | — | Comma-separated extra origins; `localhost` on any port is always allowed. |

## Circuit artifacts

`artifacts/` is empty in git and has to be filled before the service can prove
anything. `payment.zkey` is gitignored repository-wide, and the 5 MB
`payment.wasm` is not worth carrying in history when it is reproducible from
source in seconds.

`make up` at the repository root fills it for you: a container compiles the
circuit and produces the key, and the prover mounts the result. Nothing has to
be installed to do that. See [the local stack](../../docs/deploy/local-stack.md).

To build them on the host instead, the circuit lives in
[`circuits/`](../../circuits/) and builds its own key:

```bash
cd ../../circuits
npm install
npm run build            # compiles, then a development proving key

mkdir -p ../services/prover/artifacts
cp build/payment.zkey build/payment_js/payment.wasm ../services/prover/artifacts/
```

That key has a real phase 1 — the adopted Perpetual Powers of Tau contribution
80 — and a development phase 2 with one contribution and no beacon. It stays a
development key until [#16][i16] runs the ceremony, and nothing built on it
carries an assurance claim. See
[docs/disclosure/zk-setup-status.md](../../docs/disclosure/zk-setup-status.md).

[i14]: https://github.com/wienerlabs/square/issues/14
[i16]: https://github.com/wienerlabs/square/issues/16

## Tests

```bash
npm test                                              # unit tests, no artifacts needed
PROVER_ARTIFACTS_DIR=/path/to/artifacts npm test      # adds the real end-to-end proof
```

The end-to-end suite drives `POST /prove` through a genuine Groth16 prove and
reads back everything the service wrote to stdout and stderr. It skips, loudly,
when the artifacts are absent rather than passing on a stub.

`test/fixtures/circuit-ground-truth.json` is the witness output of the compiled
circuit for the fixtures beside it — not a hand-written expectation. It is what
`test/rules.test.js` compares the off-circuit rule evaluator against.
Regenerate it after any circuit change:

```bash
node test/tools/regenerate-ground-truth.mjs --wasm-dir ../aperture/circuits/payment-prover/build/payment_js
```

## What changed from aperture

### The violation log (#4)

On a non-compliant payment the service used to write the entire request body to
stderr:

```jsonc
{"event":"compliance_violation_input","input":{ /* the whole request */ }}
```

That is the operator's ceilings, their blocked list, their whitelist and their
endpoint category, in plaintext — precisely the values the circuit exists to
keep out of anyone's reach. It now writes:

```jsonc
{"event":"compliance_violation","operator_id":"…","violated_rules":["daily_limit"]}
```

Three keys, always. Nothing from the request can reach the line, because the
entry is built from a closed allowlist in `src/logging.js` and the rule names
are filtered against the six constants in `src/rules.js`.

Answering *which* rule failed needs something the circuit does not provide — it
only exposes `is_compliant`. `src/rules.js` recomputes the six predicates from
the same witness the circuit consumes and reports the names. When the two
disagree, the names are withheld and a `rule_evaluation_divergence` entry is
written instead: naming the wrong rule is worse than naming none.

`violated_rules` is also returned in the response. That is the legitimate
channel the leaked log line was standing in for — the caller supplied the
policy those names refer to, so a name tells them nothing they did not already
know, and an operator debugging a rejected payment now has an answer that does
not require reading a log they should not have.

### Error messages

The same class of leak lived on the error path, which reaches both the log and
the HTTP response. A malformed blocked address was echoed verbatim, an
over-long endpoint category was echoed verbatim, and `BigInt("abc")` throws
`Cannot convert abc to a BigInt` — putting a malformed spending ceiling in the
log the same way. Every request value now passes through `src/normalize.js`
first, and every error names the field and never the value.

### OpenAPI spec

The inherited spec had drifted from the code and was rewritten against it in
#4. #18 changed the wire format again for EVM, and the spec moved with it.

## Re-parameterised for EVM (#18)

[#14][i14] took the circuit to eight public signals and EVM addresses. This
service follows, and the wire format changed with it:

| Was | Is | Why |
|---|---|---|
| `payment_amount_lamports`, `max_daily_spend_lamports`, … | `payment_amount`, `max_daily_spend`, … | Amounts are USDC base units at 6 decimals, not lamports and not wei. |
| `payment_token_mint` | `payment_token` | It is an ERC-20 address, not an SPL mint. |
| base58 32-byte addresses | 20-byte `0x` addresses | An EVM address fits in one field element. |
| ten `public_signals` | eight | `recipient_high`/`low` and `token_mint_high`/`low` collapsed to one each. |
| `groth16`, `proof_hash`, `receipt_bytes` | `solidity` | The old fields encoded a proof for `groth16-solana`. `solidity` carries the arguments the on-chain verifier takes. |

Addresses are no longer Poseidon-hashed before list membership either. That
hash existed only to fold two halves into one comparable value; with a single
element, membership is plain equality — and the mask arrays that came with it
are gone, because they were not covered by `policy_data_hash` and zeroing one
switched a rule off while leaving the commitment identical.

The drift guard stays strict in both directions. A circuit and a service that
disagree about the public layout produce proofs that verify against the wrong
statement, which is worse than a hard failure: the contract would read an
amount out of a slot holding a timestamp.

`test/circuit-agreement.test.js` holds this service's witness against the
compiled circuit — the public signals, the policy commitment, and the
compliance verdict rule by rule. `test/solidity-encoding.test.js` checks the
proof encoding against `snarkjs zkey export soliditycalldata`, the same tool
that generates the verifier contract.

[i18]: https://github.com/wienerlabs/square/issues/18
