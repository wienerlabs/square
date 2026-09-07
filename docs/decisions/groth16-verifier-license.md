# The Groth16 verifier is written here, under Apache-2.0

**Status:** decided in [#75][i75]. Binds [#16][i16] (the ceremony redeploy) and
[#27][i27] (the compliance hook that calls the verifier).

[i16]: https://github.com/wienerlabs/square/issues/16
[i27]: https://github.com/wienerlabs/square/issues/27
[i75]: https://github.com/wienerlabs/square/issues/75

## The problem

`snarkjs zkey export solidityverifier` emits a contract whose licence header
comes from snarkjs's own template, so the output is GPL-3.0 with no output
exception. It was the one file in the tree that was neither Apache-2.0 nor
MIT, it was declared in NOTICE, and #75 asked whether it should stay.

## The options #75 listed, and a fourth

| Option | Tree | Toolchain | Cost |
|---|---|---|---|
| 1. Keep the generated file | GPL-3.0 stays, declared | unchanged | none now, a diligence question later and an open derivative-work question for #27 |
| 2. Switch to gnark | Apache-2.0 | proving system, prover service, fixtures and encoding all change | high, and it moves the circuit off circom |
| 3. Move the file to its own repository | this tree clean | unchanged | another repository to run, the same question moved one hop |
| **4. Write the verifier, keep the proof format** | Apache-2.0 | unchanged | one contract of about 150 lines, verified by the fixtures that already exist |

## Decision: option 4

Groth16 verification is one equation over four pairings on BN254 and the
chain already provides the arithmetic as precompiles `0x06`, `0x07` and `0x08`.
`contracts/src/Groth16Verifier.sol` now implements that equation directly:

```
e(-A, B) · e(alpha, beta) · e(L, gamma) · e(C, delta) == 1,   L = IC_0 + sum(IC_i · input_i)
```

with a scalar-field check on the eight public signals and `false` rather than
a revert on any malformed input, which is the behaviour the hook needs.

What is not copied: the template, its assembly, its layout, its names. What is
kept: the verifying key. The key is a set of field elements produced by the
trusted setup; it is data about a specific circuit, not an expression of the
template, and it is exactly what changes when #16 runs the ceremony.

The ABI is unchanged: `verifyProof(uint256[2], uint256[2][2], uint256[2],
uint256[8]) returns (bool)`, with the G2 limb order the prover already emits
(imaginary part first, the precompile's order). Nothing in the prover service,
the fixtures or #27 moves.

## Why not the others

Option 1 leaves a question in the tree that has to be answered by every reader
of NOTICE and by #27's author. Option 2 pays for a toolchain migration to solve
a licensing question that has a cheaper answer. Option 3 relocates the question
without answering it.

## The derivative-work question

It is moot for this repository: no GPL-3.0 code remains. For the record, the
position that a contract calling a separately deployed verifier at another
address is not a derivative of that verifier is the reasonable reading and is
the one this project would have taken; it is no longer needed.

## What #16 has to do

The ceremony produces a new proving key and therefore a new verifying key.
Export it and regenerate the constants block:

```bash
snarkjs zkey export verificationkey payment_final.zkey verification_key.json
node contracts/script/verifier-constants.mjs verification_key.json
```

Paste the output over the constants in `Groth16Verifier.sol`, run
`forge test --match-contract Groth16Verifier` against fixtures regenerated
from the new key, redeploy, and record the address. No template, no snarkjs
Solidity export, no licence change.

## Evidence

- The existing fixture suite passes unchanged: a real compliant proof and a
  real non-compliant proof verify, a flipped `is_compliant`, a substituted
  recipient, an altered amount, a tampered point and an out-of-field value are
  refused.
- Gas is measured by `test_gas_verifyProof` and on Arc after the redeploy; the
  numbers are in `contracts/README.md`.
- NOTICE no longer lists a GPL-3.0 file.
