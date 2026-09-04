# @mandate/prover

HTTP service wrapping snarkjs to generate Groth16 proofs for the
payment-compliance circuit.

Carried over from `aperture/services/prover-service` under [#4][i4], with the
compliance-violation log leak fixed on the way in — see
[What changed from aperture](#what-changed-from-aperture).

[i4]: https://github.com/wienerlabs/mandate/issues/4

## Endpoints

| | |
|---|---|
| `GET /health` | Liveness probe. |
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

The circuit itself is not in this repository yet — it arrives with [#14][i14],
which also re-parameterises it from ten public signals to eight. Until then,
build from the aperture copy:

```bash
git clone https://github.com/wienerlabs/aperture.git ../aperture
cd ../aperture/circuits/payment-prover
npm install
circom payment.circom --r1cs --wasm --sym -l node_modules -o build

# A development proving key. This is NOT a ceremony: it exists so tests can
# run. See docs/disclosure/zk-setup-status.md.
snarkjs powersoftau new bn128 13 pot13_0.ptau -v
snarkjs powersoftau contribute pot13_0.ptau pot13_1.ptau --name="dev-only" -e="$(head -c 32 /dev/urandom | base64)"
snarkjs powersoftau prepare phase2 pot13_1.ptau pot13_final.ptau -v
snarkjs groth16 setup build/payment.r1cs pot13_final.ptau payment_0.zkey
snarkjs zkey contribute payment_0.zkey payment.zkey --name="dev-only" -e="$(head -c 32 /dev/urandom | base64)"

mkdir -p artifacts && cp payment.zkey build/payment_js/payment.wasm artifacts/
```

[i14]: https://github.com/wienerlabs/mandate/issues/14

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

The inherited spec had drifted from the code: it named
`daily_spent_so_far_lamports` where the service reads
`daily_spent_before_lamports`, omitted `policy_id`, `operator_id`,
`current_unix_timestamp`, `time_restrictions` and `stripe_receipt_hash`, and
still advertised `journal_digest`, `amount_range_min`, `amount_range_max` and
`image_id` — response fields left over from the RISC Zero prover that the
Circom implementation never produced. It is rewritten against the code.

### Carried over unchanged

`src/convert.js` still encodes proofs for `groth16-solana`. It is dead weight
on an EVM chain and [#17][i17] deletes it; it is kept here so the port is a
port, and pruning happens where the issue says it happens.

The public-signal layout is still ten. [#14][i14] takes it to eight and
[#18][i18] updates this service; the drift guard in `src/prover.js` fails hard
if the circuit and the service ever disagree about the count.

[i17]: https://github.com/wienerlabs/mandate/issues/17
[i18]: https://github.com/wienerlabs/mandate/issues/18
