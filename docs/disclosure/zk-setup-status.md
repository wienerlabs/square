# Trusted setup status

**The trusted setup this project inherited is a demo setup in both phases. It is
not a ceremony, no security claim rests on it, and none may be made until the
ceremony in [#16][i16] completes.**

We say this ourselves, on every surface, without being asked. A reader who
learns it from us has been told something; a reader who discovers it during
diligence has caught us.

This document is the source the other surfaces quote from. When the wording
here changes, [surfaces.md](./surfaces.md) says where else it has to change.

[i16]: https://github.com/wienerlabs/mandate/issues/16

---

## What is actually in the file

Groth16 needs a two-phase setup. Both halves of this one are development
quality, for different reasons.

| Phase | What it covers | What was used | Standing |
|---|---|---|---|
| Phase 1 — powers of tau | Universal, circuit-independent | Not the Perpetual Powers of Tau. The key's alpha and beta do not match that ceremony, so the tau was generated locally. | **Demo only.** |
| Phase 2 — circuit-specific | Bound to `payment.circom` | One contribution, named `aperture-mpp-1777587329`. No beacon. | **Demo only.** |

A phase-2 setup is sound as long as *at least one* contributor destroyed their
toxic waste. One contribution and no beacon collapses that to a single machine.
A locally generated phase 1 collapses the same way, one stage earlier: whoever
ran `powersoftau new` held tau.

Either half on its own is enough. Whoever held that entropy can produce a proof
that verifies for **any** statement — including `is_compliant = 1` on a payment
that breaks the mandate. It is not a weakness in the circuit, the verifier, or
the pairing check: those do what they say. It is that the soundness of the
deployment rests on one party rather than on nobody.

## Evidence

Run it yourself against the artifact the prover service actually loads:

```console
$ git clone https://github.com/wienerlabs/aperture.git ../aperture
$ node circuits/scripts/inspect-zkey-setup.mjs ../aperture/services/prover-service/artifacts/payment.zkey
file                     ../aperture/services/prover-service/artifacts/payment.zkey
zkey version             1
public signals           10
witness variables        7441
domain size              8192

phase-1 ceremony         UNRECOGNISED
  vk_alpha_1             20271393493469871173572132209102235822982362344335722917727196559160584308264
                         7843795352160579649982960800198346689749733218678657422446249153045011438887
  vk_beta_2              12727801971106844995116359760428578636541892383336835174020017670880724773267
                         17840433407326282383080362070838916904574410183632472563591939737525751556503
                         10681962561559100751857179817449241692525090936182322379420055834290756429686
                         17586447429969529590097385423913201896312416663347977254034365190474901541377

phase-2 contributions    1
beacon applied           no

contributions:
  [1] contribute name="aperture-mpp-1777587329"
      transcript=cf98f1393493625c67b718d91e400872984633d640a2732084389c88e1a128e2da38d0642aaca1c02fc95985fb8330005690c9d33be870c2fb45f6a37d24b349

ASSESSMENT
  phase 1: UNRECOGNISED. The alpha and beta in this key do not match the
           Perpetual Powers of Tau. Either it was built on a different public
           ceremony — in which case publish which one, and its transcript — or
           the tau was generated locally, in which case one machine held it and
           phase 1 is as forgeable as a single-contributor phase 2.
  phase 2: single contribution, no beacon. Soundness rests entirely on one
           machine having destroyed its toxic waste.

  Either phase alone is enough to let whoever held that entropy forge a proof
  for any statement, including a false one. Describe this setup as a demo.
```

[`circuits/scripts/inspect-zkey-setup.mjs`](../../circuits/scripts/inspect-zkey-setup.mjs)
reads both phases straight out of the zkey binary.

### How phase 2 is read

Section 10 of the zkey is the MPC parameter block snarkjs writes: a contribution
list, reported without interpretation. `kind=contribute` means the entropy came
from a human; `kind=beacon` would mean it came from a public, verifiable source.
There is one record and it is `contribute`.

### How phase 1 is identified

The zkey does not record which ptau produced it — no filename, no hash. It can
still be identified. In snarkjs's Groth16 setup, `vk_alpha_1` and `vk_beta_2`
are copied straight out of the ptau, and phase-2 contributions only ever update
`delta`. So that pair is a fingerprint of the ptau: identical for every circuit
built on it, different for every independently generated tau.

Two facts make the comparison decisive, and both are checkable:

- **The fingerprint is right.** The values the tool compares against were read
  out of verification keys published by projects that document building on
  `powersOfTau28_hez_final_*`. Those exact decimal strings occur in roughly six
  thousand unrelated GitHub repositories — Aptos, Sui, anon-aadhaar, and on. A
  shared public ceremony looks like that; a locally generated tau never does.
  Aperture's alpha and beta appear in exactly one repository: aperture's own.
- **The reader is right.** Field elements sit in the zkey in Montgomery form;
  converting them out reproduces `payment_vk.json` byte for byte.

The check was validated in both directions before being trusted:

| zkey | Phase-1 verdict | Role |
|---|---|---|
| `masa-finance/masa-zkSBT` — documents building on `powersOfTau28_hez_final_11` | Perpetual Powers of Tau | Positive control. A different circuit and a different power still match, which is what makes the pair a ceremony fingerprint rather than a circuit artifact. |
| A tau generated locally here with `snarkjs powersoftau new bn128 13` | UNRECOGNISED | Negative control. |
| Aperture's shipped `payment.zkey` | UNRECOGNISED | The subject. |

This corroborates what aperture's own circuit README documents, at
`circuits/payment-prover/README.md:82`: the procedure for `payment.circom`
begins `snarkjs powersoftau new bn128 14`, which creates a tau rather than
downloading one. The same file lists a Hermez ptau as *future* work under
"Phase 5", and says the real circuit "will use" a public ceremony.

A comment in `programs/verifier/src/groth16_vk.rs:18` and the FAQ on
a-perture.com state the opposite — that phase 1 is the Hermez ceremony with 54 contributors <!-- ci-allow-phrase -->
— and neither is supported by the artifact. They are corrected by the patches
under [patches/](./patches/).

The zkey itself is not tracked here (`*.zkey` is gitignored). It ships in
[aperture][ap] at `services/prover-service/artifacts/payment.zkey`.

`public signals 10` in that output is the layout [#14][i14] replaces with 8. It
is independent of any of this: re-parameterising the circuit changes what a
proof commits to, not who could forge one.

[ap]: https://github.com/wienerlabs/aperture
[i14]: https://github.com/wienerlabs/mandate/issues/14

## What this does and does not mean

Affected:

- Any statement that a proof produced against this zkey is *unforgeable*.
- Any statement that compliance is enforced *trustlessly* today.
- Any figure presented as a security guarantee rather than a measurement.

Not affected:

- The circuit's logic. `payment.circom` constrains what it says it constrains,
  with the exception tracked separately in [#14][i14] (Rule 6 is unsound for a
  different reason — under-constrained timestamp witnesses — and is being
  removed rather than fixed).
- Proof verification. Groth16 verification against the shipped verifying key is
  real, on-chain, and correct. A verifying proof means the prover knew a
  witness *or* held setup entropy from either phase.
- Benchmarks. Proving time, proof size and gas are measurements; they do not
  become claims because the setup is weak.

## The wording

Use, verbatim or close to it:

> The ZK trusted setup inherited from the prior work is a demo setup in both
> phases, not a ceremony. A public multi-party ceremony covering both is
> planned. Until it completes, no claim of production-level assurance applies to
> anything in this repository.

Short form, where a sentence is all there is room for:

> The trusted setup is a demo: phase 1 was generated locally and phase 2 has one
> contribution with no beacon. The public ceremony has not been held.

Never write, in any language: that the setup is production-anything, that the
ceremony has been held, or that phase 1 is the Hermez powers of tau. <!-- ci-allow-phrase -->
[forbidden-phrases.txt](./forbidden-phrases.txt) carries the enforced list and
CI fails the build on a match.

Citing a 54-contributor ceremony that this key was not built on is the specific
error this document was written to correct. It was in the first version of this
PR, taken from a source comment rather than from the artifact, and it is the
reason the tool now reads both phases: a provenance claim that cannot be
checked does not belong on any of these surfaces, including this one.

## When this lifts

[#16][i16] — the public ceremony — is the only thing that lifts it.

Phase 1 is already settled, and by adoption rather than by running anything:
[#15](https://github.com/wienerlabs/mandate/issues/15) adopted the Perpetual
Powers of Tau contribution 80, hash-verified, and keys built in this repository
now stand on it — [docs/ceremony/phase1-ptau.md](../ceremony/phase1-ptau.md) is
the record and `circuits/scripts/inspect-zkey-setup.mjs` recognises it in a
finished key. That leaves #16 with phase 2: a multi-party contribution chain
with a beacon announced in advance. Refreshing phase 2 alone would have been
pointless while phase 1 was still one machine's tau, which is why the adoption
came first.

None of this changes what the *inherited* aperture key is. That one is still a
demo in both phases, and everything above still describes it.

Until then, the sequence is fixed: [#14][i14] freezes the circuit, [#15][i15]
organises the ceremony, [#16][i16] runs it, [#17][i17] deploys the verifier
generated from its output.

[i15]: https://github.com/wienerlabs/mandate/issues/15
[i17]: https://github.com/wienerlabs/mandate/issues/17
