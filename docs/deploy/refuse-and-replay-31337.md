# A non-compliant payment is refused, and a spent proof pays once

**Status:** measured for [#76][i76] on a local chain (`31337`). Reproduce with
`node contracts/script/refuse-and-replay-on-anvil.mjs` against a fresh anvil
with `DeployLocal.s.sol` on it; CI runs the same thing as
`refuse and replay (policy → proof → anvil)` in `circuits.yml`.

[i19]: https://github.com/wienerlabs/square/issues/19
[i27]: https://github.com/wienerlabs/square/issues/27
[i76]: https://github.com/wienerlabs/square/issues/76
[i100]: https://github.com/wienerlabs/square/issues/100
[i190]: https://github.com/wienerlabs/square/pull/190

## What is being claimed

Two things [#19][i19] could not show, because the chain surface it had was a
stateless `view` verifier:

1. **A non-compliant payment is refused.** The circuit proves that the six
   checks *ran*, not that they passed, so a proof carrying `is_compliant = 0`
   is a valid proof and the verifier accepts it — on purpose. Refusing the
   release is the compliance module's job.
2. **A spent proof cannot pay twice.** A `view` function has nowhere to record
   what it has seen.

[#27][i27] built both into `ComplianceModule`. This is the end-to-end evidence:
the proof comes from the real prover, is built from what the chain says about
the job, and the release goes through the real kernel, keeper and hook.

"Refused" means what [#100][i100] made it mean: the job still settles, and the
provider is paid nothing while the client gets the whole net back. A verdict is
a split, never a revert, because a reverting hook once left escrow with no exit.

## The run

```console
$ node contracts/script/refuse-and-replay-on-anvil.mjs
rpc      http://127.0.0.1:8547
chain id 31337
kernel   0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9

D  the hook with no module, for the baseline
  ok    the provider is paid the whole net
        gas 228174

verifier 0x59b670e9fA9D0A427751Af201D676719a970857b (this build's key)
module   0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1

A  over the per-transaction ceiling
  ok    the circuit says it is not compliant
  ok    the per-transaction rule is the one that failed
  ok    and the verifier still accepts the proof
  ok    the module refuses it, by name
  ok    the provider is paid nothing
  ok    the client gets the whole net back
  ok    and the day is not charged for it
        gas 759702

B  a compliant payment
  ok    the circuit says it is compliant
  ok    the module verifies it
  ok    the provider is paid the net
  ok    the day is charged exactly that
        gas 808347

C  B's proof, byte for byte, on an identical job
  ok    the module refuses it, by name
  ok    the provider is not paid twice
  ok    the day is not charged twice
        gas 742398

E  B's proof re-randomised: same eight signals, different bytes
  ok    the signals are the ones already spent
  ok    the bytes are not
  ok    and this build's verifier accepts the copy
  ok    the module refuses it, by name
  ok    the provider is not paid for it
        gas 742386

gas, finalize end to end
  D  no module (baseline)         228174
  A  refused, not compliant       759702   +531528 over the baseline
  B  released                     808347   +580173 over the baseline
  C  refused, same bytes          742398   +514224 over the baseline
  E  refused, re-randomised       742386   +514212 over the baseline

net released in B: 19.700000 USDC

Refused when not compliant, released when compliant, and a spent proof paid once — as the same bytes and as a re-randomised copy.
```

Every refusal is read off the module's own `ReleaseRefused` event and compared
by reason — `is_compliant is 0`, `proof already used` — so a job refused for
the wrong reason fails the run rather than passing it.

## Measured

Gas is each `finalize` transaction's receipt, not an estimate, and the gate's
cost is the difference from job D, which went through the same kernel, keeper
and hook with no module installed.

| Job | What happened | Gas | Over the baseline |
|---|---|---|---|
| D | released, no module | 228 174 | — |
| A | refused: `is_compliant is 0` | 759 702 | +531 528 |
| B | released: proof verified, counter moved | 808 347 | +580 173 |
| C | refused: `proof already used`, same bytes | 742 398 | +514 224 |
| E | refused: `proof already used`, re-randomised | 742 386 | +514 212 |

**A gated release costs about 580 000 gas more than an ungated one.** Most of
that is two Groth16 pairing checks: the kernel reads the verdict through the
hook's `resolvePayout`, which is a `view` and cannot leave a note for the
stateful `beforeAction` that follows, so the module verifies once to decide the
split and again to move the counter and mark the proof. The per-call figures
for those two calls are in [compliance-gate.md](../design/compliance-gate.md);
this is the same cost seen end to end, through the keeper.

**A refused replay costs almost as much as a release**, and that is worth
saying rather than leaving to be discovered. The module decodes the proof, runs
the pairing, and only then checks whether the statement was already spent — so
C and E each pay for two pairings to be told no. Checking the mark between the
decode and the pairing would make a replay cheap, and the outcome would be the
same refusal; it is not done here because the mechanism is [#27][i27]'s and
this issue measures it rather than changing it.

## Why a local chain

Nothing here needs Arc's precompiles — [#19][i19] already runs the verifier
against Arc's own `0x06`/`0x07`/`0x08` — and everything here needs something a
shared testnet cannot give a CI run:

- **a hook whose owner key is on the runner**, to install a module; the
  deployed Arc hook is owned by the account that redeployed it, and it has no
  module installed;
- **a clock that moves**, past `KeeperEvaluator`'s one-day challenge window;
- **accounts that sign without secrets**, which anvil's unlocked accounts are.

The script refuses to run anywhere but chain 31337, and checks that the node
answers `anvil_nodeInfo`, because it warps the clock and signs as unlocked
accounts.

## Why a second verifier and module

CI builds its own development proving key, and phase 2 draws fresh entropy per
build, so delta differs and a verifier generated from the committed key
rejects every proof this run produces — silently, at the pairing. So the script
compiles the repository's `Groth16Verifier.sol` with this build's constants,
the same way #19 does, deploys it, deploys a `ComplianceModule` bound to it,
and installs that in the hook.

`DeployLocal.s.sol` is left alone: its own module is bound to the committed
verifier, and deploying anything extra from the deployer before it would shift
the deterministic addresses `packages/core` holds for chain 31337.

## Scenario E, and why it is here

[#190][i190]'s review found that the replay mark was keyed on
`keccak256(proof)`, and that a Groth16 proof is not bound to its own encoding:
for any r, s, `(rA, r⁻¹B + sδ, C + rsA)` verifies for the same public signals.
The mark was moved to the statement — a hash of the eight signals — and
`test/Malleability.t.sol` shows the verifier accepting such a copy.

Scenario E is that attack end to end: B's proof, re-randomised by
`circuits/scripts/rerandomise.mjs` against this build's delta, accepted by this
build's verifier, and still refused by the module with `proof already used`.

## What this does not show

- **Nothing on Arc.** [#28][i28] asks for the six contract-level scenarios on
  Arc Testnet, which needs the compliance module deployed and installed on the
  shared testnet stack by the account that owns its hook.
- **Nothing about assurance.** The key has a real phase 1 and a development
  phase 2; see docs/disclosure/zk-setup-status.md.

[i28]: https://github.com/wienerlabs/square/issues/28
