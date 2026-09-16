# The proof gate on the way out of escrow

**Status:** implemented for [#27][i27]. Written against the contract
[#100](../decisions/hook-failure-modes.md) set for it, and read together with
[public-daily-ceiling](../decisions/public-daily-ceiling.md), which is what the
counter it reads means.

[i27]: https://github.com/wienerlabs/square/issues/27
[i29]: https://github.com/wienerlabs/square/issues/29
[i30]: https://github.com/wienerlabs/square/issues/30
[i76]: https://github.com/wienerlabs/square/issues/76
[i90]: https://github.com/wienerlabs/square/issues/90
[i100]: https://github.com/wienerlabs/square/issues/100
[i225]: https://github.com/wienerlabs/square/issues/225
[i335]: https://github.com/wienerlabs/square/issues/335

## The verdict is a split, not a veto

#27 was written as "the proof locks the release", and its acceptance criteria
say `complete` **reverts** without a proof. Between #27 being written and being
built, [#100][i100] settled something that overrides that, and named this
contract while doing it:

> A gating module cannot lock money by reverting, because the kernel no longer
> lets it. If a policy must stop a release, the hook has one channel that the
> kernel honours: `resolvePayout` returns `(payee, providerBps)`, and
> `providerBps = 0` returns the whole net to the client. A verdict is a split,
> never a revert. The ComplianceHook of #27 has to be written against that
> contract.

The reason is in that record: after [#90][i90] closed the refund on a
`Submitted` job under a horizon evaluator, a hook that reverted left the escrow
with **no exit at all** — `complete`, `reject` and `claimRefund` were all
closed, and there is no recovery function.

So the gate reads, in two halves that used to be one.

A proof the mandate itself refuses pays the provider nothing and returns the
whole net to the client. The job settles, the state machine does not stall,
and the reason is on chain. That is a decision, and a decision is allowed to
go against the provider.

A job with no proof, a proof of the wrong length, or bytes that do not verify
is not a decision at all, and it no longer settles. `KeeperEvaluator.finalize`
and `finalizeDecided` ask the hook for `proofState(jobId)` first and revert
`ProofRequired(jobId, state)` rather than call `complete`. The job stays
`Submitted` and the escrow stays where it is. The client is the only party who
can bind a proof, so the client is the only party who can end the hold, which
is the point: before this, a client who bound nothing took the escrow back
after a delivery it had already received.

The hold is the evaluator's refusal to settle, not a hook revert, so the
contract in the paragraph above still stands: the hook never throws on the
release path, and the escrow lock #100 removed does not come back. And
`claimRefund` is not a way around it. The probe the kernel sends still reads
as resolvable while a module is installed, so an expired `Submitted` job with
no proof is refused with `SettledByEvaluator` rather than refunded.

One more thing moves with it. The policy commitment a proof is checked
against is now pinned when the job is funded, in the hook's `FUND_SELECTOR`
branch, and read back through `commitmentAtFund(jobId)`. A client cannot fund
a job, take delivery, move to another mandate and collect a refusal it wrote
itself. For the same reason a client who has committed to no mandate at all
cannot fund: `NoPolicy(client)` is raised before the money moves, because that
job could never have released.

## Where the verdict has to be computed

`SquareJob.complete` does two things in order:

```
(payee, providerBps) = _resolvePayout(job, jobId, data);   // view, strict
_beforeHookTolerant(job.hook, jobId, data);                // stateful, tolerant
```

The split comes from the first, and the first is a `view`. The counter advance
and the replay mark are writes, and they can only happen in the second. So the
module has two entry points over one decision:

| | Called from | Can write | What it is for |
|---|---|---|---|
| `previewRelease` | `SquareHook.resolvePayout` | no | the verdict that becomes the split |
| `checkRelease` | `SquareHook.beforeAction` | yes | the counter, the mark, the validation record |

Both run the same checks over the same state inside one transaction, so they
agree. That agreement is load-bearing: `checkRelease` sits inside a tolerant
call, so a revert there is swallowed while the money moves. The module is
therefore written so that **`previewRelease` returning true implies
`checkRelease` completes** — every way the second call can fail, and not only
the proof, is checked by the preview first. [#225][i225] found three ways it was
not, and the section below is what was done about them.

The cost of computing the verdict twice is one extra pairing check. Measured:

| Call | Gas | Cap |
|---|---|---|
| `resolvePayout`, preview included | 383 662 | 1 000 000 |
| `checkRelease`, verify plus writes | 383 166 | 1 000 000 |
| a gated `complete`, end to end | 1 091 607 | — |

Each capped call uses under half of its cap. That margin is the criterion,
not the total: a preview that ran out of gas inside the cap would be caught and
read as "not verified", so a valid proof would be refused and the client paid —
a silent and expensive failure. `test_gas_eachCappedCallHasHeadroom` asserts it.

The same gate measured end to end — a proof from the real prover, released
through the keeper on a local chain — is in
[refuse-and-replay-31337.md](../deploy/refuse-and-replay-31337.md): a gated
`finalize` costs about 580 000 gas more than an ungated one, and a refused
replay nearly as much, because the mark is checked after the pairing.

## When the preview said yes and the check could not

The invariant above was written about `PolicyRegistry.recordSpend` and checked
only one of the two things that call reverts on. [#225][i225] measured what the
gap cost. `SquareJob.complete` takes the split from `resolvePayout` and pays on
it, then calls `beforeAction`; a `checkRelease` that reverts inside that
tolerant call takes its whole frame with it, **including the replay mark, which
was written in it**. So the provider was paid, `spentToday` never moved, the
mark was rolled back, and the same proof was good for the next job. Three jobs,
one proof, on main before this change: 15 000 000 paid, counter unmoved,
`isConsumed` false. Neither defence the section on replay below describes was
left standing.

Three ways in, and two of them are ordinary administration:

| Way the check could fail | Reached by | What the preview checks now |
|---|---|---|
| `OnlyHook` | a hook rotated in with `setComplianceModule` while the module still authorises the old one | the job's own hook is the module's hook, and `setHook` refuses the zero address |
| `NotASpender` | `PolicyRegistry.setSpender(module, false)`, the first and most careful step of rotating a module, taken by the registry's owner alone | `isSpender(module)`, refusing with `not a spender` |
| `SpendOverflow` | a day's total past `uint128` | already covered: the ceiling keeps it at or below `dailyLimit` |
| out of gas | a `hookGasLimit` between what the preview costs and what the check costs, which `HOOK_GAS_LIMIT` in `DeploySettlement.s.sol` can set without anyone making a mistake | the constructor refuses such a kernel |

The gas one is a floor rather than a binding, because it is a property of the
kernel and not of the release. `ComplianceModule.MIN_HOOK_GAS_LIMIT` is 450 000,
and the kernel's limit is immutable, so one check in the constructor holds for
the module's whole life. The figure is measured on every run by
`test_theFloorCoversTheCheck`, cold, on a job carrying the longest description
the kernel accepts: 432 142 for the check to book, 14 904 more for a poster's
first-ever spend, 447 046 in all, rounded up. The same test asserts the gap it
guards is still there — the check needs 432 142 where the preview needs 410 830.

A caller cannot squeeze the check under the limit instead, which matters because
`KeeperEvaluator.finalize` is permissionless and the caller picks the gas. When
a hook call runs out, the kernel keeps one 64th of what it had, and that does
not pay for the credits and events still to come, so the transaction reverts
whole rather than settling. `test_noCallerGasPaysWithoutBooking` sweeps 236 gas
limits from 250 000 to 2 600 000: 83 reverted, 153 paid and booked, none paid
unbooked.

**Behind that line.** The mark is written before the counter is advanced and
`recordSpend` is called inside `try`, so a spend the registry refuses no longer
takes the mark with it: the proof is spent, `checkRelease` returns false with
`spend not recorded`, and the next job is refused by the mark alone even though
the counter never moved. And when the preview and the check disagree at all,
the hook says so by name: `afterAction` reads the split the kernel applied and
emits `ReleaseUnconfirmed(jobId, payee, amount)` when money left escrow with the
check not passed. It should never fire; the indexer counts it into
`square_hook_write_failures_total{kind="complianceCheck"}` and the
`hookWriteFailures` alert fires on the first one.

**One consequence worth stating.** A rotation now fails closed on both sides. A
job whose hook is not the module's hook is paid nothing, so jobs left on an old
hook refund the client rather than paying an unbooked release, and the operator
finishes the rotation with `setHook` before those jobs settle.

## The eight bindings

The verifier is stateless. It says a proof is valid for eight public signals,
not that those signals describe *this* payment. An unbound proof is a bearer
token: one compliant payment, replayed against every other job.

Aperture cross-checked the public inputs against the real transfer in the
accounts passed to the instruction. The EVM counterpart is the job's own
storage:

| # | Signal | Bound to |
|---|---|---|
| 0 | `is_compliant` | must be 1 |
| 1 | `policy_data_hash` | `PolicyRegistry.commitmentOf(client)` |
| 2 | `recipient` | the address the kernel will actually pay |
| 3 | `amount` | the net payout after fees and the split |
| 4 | `token` | `SquareJob.paymentToken()` |
| 5 | `daily_spent_before` | `PolicyRegistry.spentToday(client)` |
| 6 | `current_unix_timestamp` | `block.timestamp` ± tolerance |
| 7 | `stripe_receipt_hash` | must be 0 |

All eight. An unbound signal is one the prover chooses, and an earlier sketch of
this module left `token` and `stripe_receipt_hash` free.

Two of them deserve their own sentence.

**Signal 2 is the payee, not the provider.** A receivable sold through
`ClaimMarket` pays its buyer ([#29][i29]), and the hook resolves that address
before the module sees it. Binding to the provider would refuse every proof on a
sold claim. Who can become that buyer is itself gated since [#30][i30]: the
poster's policy approves the buyers its receivables may be sold to
([buyer-eligibility.md](../decisions/buyer-eligibility.md)), and a proof naming
the buyer releases to the buyer (`test_soldClaimReleasesToTheBuyerTheProofNames`).

**Signal 6 is what makes the circuit's rule 6 mean anything.** `payment.circom`
takes the timestamp as a private witness the prover picks; without a window
against `block.timestamp` a prover simply chooses a time inside the policy's
hours. The tolerance covers the gap between building a proof and it being mined,
and every second of it is a second in which a window can be straddled, so it is
kept small and is owner-adjustable rather than immutable — the right value is a
property of the chain's block time and the keeper's cadence.

## Replay

Two mechanisms, and the first does most of the work.

**The daily counter.** `daily_spent_before` has to equal the poster's total for
today, and `checkRelease` advances that total by `amount` in the same call. A
proof presented a second time carries a stale signal 5. This is aperture's
`DailySpentMismatch`, and it is also what makes signal 5 mean anything at all:
without a counter on chain, a prover claims zero every time and the circuit's
daily ceiling is vacuous.

**An explicit mark, on the statement rather than the bytes.** The counter's
protection is only as good as the counter — a release of zero moves it not at
all, and a new UTC day resets it — so a spent proof is also recorded.

What is recorded is `keccak256(abi.encode(publicSignals))`, not a hash of the
proof. **A Groth16 proof is not bound to its own encoding.** For a valid
(A, B, C) and any r, s,

    A' = r·A        B' = r⁻¹·B + s·δ        C' = C + (r·s)·A

verifies for the same public inputs: e(A',B') = e(A,B)·e(rs·A, δ), and C'
absorbs the difference. The verifier checks the pairing and the signals' field
membership and nothing about the encoding, so it accepts the copy.

That is measured, not argued. `circuits/scripts/rerandomise.mjs` builds such a
copy and `contracts/test/Malleability.t.sol` hands it to
`src/Groth16Verifier.sol`, which accepts it — same eight signals, different
bytes.

Marking the bytes therefore recorded a representation. The gap it left is
narrow but real, and the counter does not cover it: a proof for the first
payment of a day, presented again just after the counter resets at midnight and
still inside the timestamp tolerance. Signals 5 and 6 both match there, and
`KeeperEvaluator.finalize` is permissionless, so anyone who saw the first
proof could re-randomise it and present it against a second job with the same
payee, amount, client and token.

Re-randomisation cannot touch the signals, so hashing them is what makes "this
statement has been spent" true rather than "these bytes have been seen".
`test_aRerandomisedCopyOfASpentProofIsRefused` opens that window on purpose —
past midnight, counter put back, tolerance widened so the timestamp still
matches — and asserts the refusal arrives by name, `proof already used`, with
nothing else left to refuse it. Against the old mark it fails on the assertion
that says so.

A job cannot complete twice, since `complete` requires `Submitted`. So replay
is about a proof crossing from one job to another, which the bindings make hard
and these two make impossible.

## What this does not do

- **It does not reject a proof, in the sense [#76][i76] means.** The verifier is
  a `view` function and this module records only what it consumed. Surfacing a
  rejection end to end, and the replay demonstration against a live chain, is
  #76's job and builds on what is here.
- **It carries no assurance.** The key has a real phase 1 and a development
  phase 2; see docs/disclosure/zk-setup-status.md.
- **It is not installed by default on a dev chain.** Once the hook holds a
  module every completion needs a proof bound to the job, and the suites that
  share the default stack (the indexer's, the keeper's, the compose stack) do
  not bind one; installing it by default would route their money to the
  client. `DeployLocal.s.sol` deploys and wires the module and installs it
  only under `INSTALL_COMPLIANCE_MODULE=true`. What does bind proofs is the
  institution's side, `packages/policy` and the surfaces built on it: the
  `square policy` commands, `square_hire`, the hosted agent's delegation, the
  lifecycle runner and the app ([#335][i335],
  [docs/decisions/proof-freshness.md](../decisions/proof-freshness.md)). Their
  suites run against a stack whose module is keyed to the prover beside it
  (`packages/policy/scripts/install-module-for-this-build.mjs`), since the
  verifier `DeployLocal` deploys comes from one particular key and a fresh
  build draws another.
