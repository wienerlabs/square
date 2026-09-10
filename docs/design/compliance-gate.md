# The proof gate on the way out of escrow

**Status:** implemented for [#27][i27]. Written against the contract
[#100](../decisions/hook-failure-modes.md) set for it, and read together with
[public-daily-ceiling](../decisions/public-daily-ceiling.md), which is what the
counter it reads means.

[i27]: https://github.com/wienerlabs/square/issues/27
[i29]: https://github.com/wienerlabs/square/issues/29
[i76]: https://github.com/wienerlabs/square/issues/76
[i90]: https://github.com/wienerlabs/square/issues/90
[i100]: https://github.com/wienerlabs/square/issues/100

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

So the gate reads: a missing, invalid or foreign proof pays the provider
nothing and returns the whole net to the client. The job still settles, so the
state machine never stalls, and nobody's money is stranded. "The proof locks
the release" is true in the only sense that does not also lock the escrow.

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
`checkRelease` can complete** — every condition `PolicyRegistry.recordSpend`
would revert on, including the daily ceiling, is checked by the preview first.

The cost of computing the verdict twice is one extra pairing check. Measured:

| Call | Gas | Cap |
|---|---|---|
| `resolvePayout`, preview included | 306 452 | 1 000 000 |
| `checkRelease`, verify plus writes | 303 871 | 1 000 000 |
| a gated `complete`, end to end | 956 794 | — |

Each capped call uses under a third of its cap. That margin is the criterion,
not the total: a preview that ran out of gas inside the cap would be caught and
read as "not verified", so a valid proof would be refused and the client paid —
a silent and expensive failure. `test_gas_eachCappedCallHasHeadroom` asserts it.

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
sold claim.

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

**An explicit mark.** `keccak256(proof)`, because the counter's protection is
only as good as the counter — a release of zero moves it not at all, and a new
UTC day resets it. `test_theMarkStopsAReplayEvenWhenTheCounterAgrees` puts the
counter back where the proof wants it and shows the mark still refuses.

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
  module every completion needs a proof bound to the job, and nothing on a local
  chain produces those — the SDK lifecycle, the indexer and keeper suites and the
  compose stack all complete with empty `optParams`, and installing it by default
  would route their money to the client. `DeployLocal.s.sol` deploys and wires
  the module and installs it only under `INSTALL_COMPLIANCE_MODULE=true`.
