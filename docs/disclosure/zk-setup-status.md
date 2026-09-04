# Trusted setup status

**The phase-2 trusted setup this project inherited is a demo setup. It is not a
public ceremony. No security claim rests on it, and none may be made until the
ceremony in [#16][i16] completes.**

We say this ourselves, on every surface, without being asked. A reader who
learns it from us has been told something; a reader who discovers it during
diligence has caught us.

This document is the source the other surfaces quote from. When the wording
here changes, [surfaces.md](./surfaces.md) says where else it has to change.

[i16]: https://github.com/wienerlabs/mandate/issues/16

---

## What is actually in the file

Groth16 needs a two-phase setup. The two halves are in completely different
shape, and collapsing them into one sentence is how the overclaim happens.

| Phase | What it covers | What was used | Standing |
|---|---|---|---|
| Phase 1 — powers of tau | Universal, circuit-independent | `powersOfTau28_hez_final_14.ptau` — the Polygon Hermez perpetual ceremony: 54 contributors plus a public beacon | **Sound.** Reused unchanged; the new ceremony does not touch it. |
| Phase 2 — circuit-specific | Bound to `payment.circom` | One contribution, named `aperture-mpp-1777587329`. No beacon. | **Demo only.** |

Phase 2 is sound as long as *at least one* contributor destroyed their toxic
waste. One contribution and no beacon collapses that to a single machine.
Whoever held that entropy can produce a proof that verifies for **any**
statement — including `is_compliant = 1` on a payment that breaks the mandate.

That is the whole failure. It is not a weakness in the circuit, the verifier,
or the pairing check: those do what they say. It is that the soundness of the
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
phase-2 contributions    1
beacon applied           no

contributions:
  [1] contribute name="aperture-mpp-1777587329"
      transcript=cf98f1393493625c67b718d91e400872984633d640a2732084389c88e1a128e2da38d0642aaca1c02fc95985fb8330005690c9d33be870c2fb45f6a37d24b349

ASSESSMENT: single-contributor phase 2 with no beacon. Soundness rests entirely
on one machine having destroyed its toxic waste. Whoever held that entropy can
forge a proof for any statement, including a false one. Describe this setup as a
demo. See docs/disclosure/zk-setup-status.md.
```

[`circuits/scripts/inspect-zkey-setup.mjs`](../../circuits/scripts/inspect-zkey-setup.mjs) parses
section 10 of the zkey binary — the MPC parameter block snarkjs writes — and
reports the contribution list without interpretation. `kind=contribute` means
the entropy came from a human; `kind=beacon` would mean it came from a public,
verifiable source. There is one record and it is `contribute`.

The zkey itself is not tracked here (`*.zkey` is gitignored). It ships in
[aperture][ap] at `services/prover-service/artifacts/payment.zkey`.

`public signals 10` in that output is the layout [#14][i14] replaces with 8.
The two are independent: re-parameterising the circuit changes what the proof
commits to, not who could forge one.

[ap]: https://github.com/wienerlabs/aperture
[i14]: https://github.com/wienerlabs/mandate/issues/14

## What this does and does not mean

Affected:

- Any statement that a proof produced against this zkey is *unforgeable*.
- Any statement that compliance is enforced *trustlessly* today.
- Any figure presented as a security guarantee rather than a measurement.

Not affected:

- Phase 1. The Hermez powers of tau stands on its own and is reused as-is.
- The circuit's logic. `payment.circom` constrains what it says it constrains,
  with the exception tracked separately in [#14][i14] (Rule 6 is unsound for a
  different reason — under-constrained timestamp witnesses — and is being
  removed rather than fixed).
- Proof verification. Groth16 verification against the shipped verifying key is
  real, on-chain, and correct. A verifying proof means the prover knew a
  witness *or* held the phase-2 entropy.
- Benchmarks. Proving time, proof size and gas are measurements; they do not
  become claims because the setup is weak.

## The wording

Use, verbatim or close to it:

> The ZK trusted setup inherited from the prior work is a demo setup, not a
> production ceremony. A public multi-party phase-2 ceremony is planned. Until
> it completes, no claim of production-level assurance applies to anything in
> this repository.

Short form, where a sentence is all there is room for:

> Phase 2 of the trusted setup is a demo: one contribution, no beacon. The
> public ceremony has not been held.

Never write, in any language: that the setup is production-anything, that the
ceremony has been held, or that the architecture is production-grade while
citing only phase 1. [forbidden-phrases.txt](./forbidden-phrases.txt) carries
the enforced list and CI fails the build on a match.

Citing the 54-contributor Hermez ceremony **on its own** is the specific dodge
found during the audit. It is true and it is not the answer to the question
being asked. Whenever phase 1 is mentioned, phase 2 is mentioned in the same
breath.

## When this lifts

[#16][i16] — the public phase-2 ceremony — is the only thing that lifts it.
Not a partial ceremony, not more contributions without a beacon, not an audit
of the circuit. When #16 closes with published transcripts, an applied beacon
matching its pre-announced source, and a third party having replayed the chain,
this document is rewritten and [#3][i3] closes.

Until then, the sequence is fixed: [#14][i14] freezes the circuit, [#15][i15]
organises the ceremony, [#16][i16] runs it, [#17][i17] deploys the verifier
generated from its output.

[i3]: https://github.com/wienerlabs/mandate/issues/3
[i15]: https://github.com/wienerlabs/mandate/issues/15
[i17]: https://github.com/wienerlabs/mandate/issues/17
