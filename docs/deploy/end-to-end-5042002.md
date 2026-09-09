# A policy, a proof built from it, and Arc accepting it

**Status:** measured for [#19][i19] on Arc Testnet (`5042002`). Reproduce with
`node contracts/script/prove-and-verify-on-arc.mjs`.

[i16]: https://github.com/wienerlabs/square/issues/16
[i19]: https://github.com/wienerlabs/square/issues/19
[i27]: https://github.com/wienerlabs/square/issues/27
[i76]: https://github.com/wienerlabs/square/issues/76

## What is being claimed

Three steps, in one run, starting from a policy and ending at Arc:

1. a policy is defined and its Poseidon commitment computed off chain;
2. the prover builds a proof from that same policy, now;
3. Arc's EVM, against Arc's own `0x06`/`0x07`/`0x08`, accepts it.

The part worth stating carefully is step 2 into step 3. `verify-on-arc.mjs`
already showed that *a* proof verifies on Arc, but it reads
`contracts/test/fixtures/proofs.json` — proofs generated at some earlier time.
That answers "does a proof verify on Arc". It does not answer "does a proof
built from this policy carry this policy's commitment into a verification the
chain accepts", which is the sentence phase 2 is finished on.

The commitment is therefore computed twice, by two pieces of code that have to
agree:

```
policy → buildCircuitInput → policyDataHash()   ordinary Poseidon, in JS
policy → buildCircuitInput → the circuit        Poseidon as constraints
```

The second is public signal 1 of the proof. `policyDataHash` is the same
implementation `circuits/test/payment.test.js` uses to hold the circuit honest,
imported rather than copied.

## The run

```console
$ node contracts/script/prove-and-verify-on-arc.mjs
rpc      https://rpc.testnet.arc.io
chain id 5042002
block    61216037

verifier  the repository contract, keyed to this build, state-overridden at a
          scratch address on Arc. Nothing deployed, nothing committed.

a policy, committed off chain
  policy_data_hash  20874387725514270809315419603381509475968254125138003687451722302879959916009

a proof built from that policy, now
  ok    the circuit committed to the same policy
  ok    is_compliant
  ok    recipient
  ok    amount
  ok    daily_spent_before
  ok    the off-circuit evaluator agrees

Arc verifies it
  ok    the proof verifies on chain
  ok    a substituted policy commitment is rejected

Arc gas for the verification: 281,596
  commitment        410 ms
  prove             575 ms
  build verifier    252 ms
  verify             71 ms
  total            1307 ms

Policy committed, proof built from it, Arc accepted it.
```

## Measured

| Stage | Time | What it is |
|---|---|---|
| commitment | 410 ms | policy → circuit input → Poseidon, in JS. Dominated by circomlibjs building its Poseidon tables, not by the hash. |
| prove | 575 ms | `snarkjs.groth16.fullProve` over 6,608 witness variables, domain size 8,192. |
| build verifier | 252 ms | compiling the repository's verifier keyed to this build (see below); with `solc` already in `~/.svm`. |
| verify | 71 ms | one `eth_call` to Arc with a state override. |
| **total** | **1,307 ms** | |

**Gas: 281,596** for one verification, from `eth_estimateGas` against Arc. The
figure moves by a few dozen between blocks — three consecutive runs gave
281,584, 281,596 and 281,608 — because an estimate is an estimate. The receipt
figure for a verification on the deployed contract is in
[contracts/README.md](../../contracts/README.md#measured-cost); this document
does not restate it, so there is one place to update.

For comparison, the GPL-licensed snarkjs verifier this one replaced cost 265,653
on the same proof. The Apache-2.0 rewrite is about 16k more.

## Why the run builds its own verifier

Not a shortcut. `circuits/scripts/build.mjs` takes its phase-2 entropy from
`crypto.getRandomValues`, so **every build produces a different proving key**,
and a verifier generated from one build matches only that build.

The failure this causes is quiet, which is why it is written down. `alpha`,
`beta`, `gamma` and the IC points come from the powers of tau and the circuit,
so they are identical across builds; only `delta` moves. Measured on this
repository, comparing a locally built key against the committed verifier:

```
IC0_X        14356068746863727973308921549689713072190441835792285784409197830350841544963
zkey IC[0][0] 14356068746863727973308921549689713072190441835792285784409197830350841544963   same

DELTA_X_RE    8141895193386382829600398786110052259980942407012205585084201487801315312054
zkey delta_2  15927582626339554818417800524847847293609245567343730572160789879975363390000   different
```

So a stale key looks almost right and fails only at the pairing, with no
diagnostic beyond `false`.

The consequence for this check: **a freshly built key cannot verify against the
committed or the deployed verifier while the development key is random.**
Pinning the script to either would test a frozen artifact rather than the
pipeline. It therefore compiles the repository's own `Groth16Verifier.sol` with
the constants of the key this run built — via
`contracts/script/verifier-constants.mjs`, which already existed for exactly
this substitution — in a scratch project outside the repository, and
state-overrides that bytecode onto Arc. The contract is the repository's; only
the key is this run's.

Making the development entropy fixed would remove the need, make the build
reproducible, and turn "this is a demo key" into something anyone can verify by
rebuilding. It would also change a security-adjacent script and the disclosure
narrative, and [#16][i16] replaces the key outright, so it is left alone here
and recorded as an option rather than taken.

## The negative control

`ok    a substituted policy commitment is rejected` is the half that makes the
other half mean something. The check substitutes public signal 1 with the
commitment of a *different* policy — same everything else, `max_daily_spend`
changed — and the chain returns `false`.

Without it, "the proof verifies" would show only that something verified, not
that the policy is bound to it. The eight signals are covered by the pairing, so
a different commitment is not a different answer; it is a proof of a different
statement. The script also refuses to run if the control policy happens to hash
to the same value, so the control cannot pass vacuously.

## What this does not show

- **Nothing about assurance.** The key has a real phase 1 — Perpetual Powers of
  Tau contribution 80 — and a development phase 2: one contribution, no beacon.
  [#16][i16] has not run. This shows the pipeline works, not that it is sound.
- **Nothing about authorisation.** `is_compliant` is a signal, not a gate. A
  non-compliant payment produces a proof that verifies; refusing to release on a
  zero, and checking that the eight signals describe the job being settled, is
  [#27][i27]'s job.
- **Nothing about replay.** The verifier is a stateless `view` function. Proof
  rejection and replay protection are [#76][i76].

## In CI

`circuits.yml`, job `end-to-end (policy → proof → Arc)`. It is deliberately
**not** a required status check yet: it is new, and it reaches a young testnet,
and the rule this repository set for itself is that a check whose red is a
statement about Arc being reachable should not block unrelated merges. Promote
it once it has run for a while without flaking — the same path
`verifies on Arc Testnet` took.
