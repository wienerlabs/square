# A hook informs, it never vetoes, on the way out of escrow

**Status:** decided in [#100][i100]. Also settles the hookless split of
[#110][i110] and the reachable half of the bond leg in [#101][i101]. Binds
[#27][i27]: a gating compliance module expresses its verdict through the
payout split, never through a revert.

[i27]: https://github.com/wienerlabs/square/issues/27
[i100]: https://github.com/wienerlabs/square/issues/100
[i101]: https://github.com/wienerlabs/square/issues/101
[i110]: https://github.com/wienerlabs/square/issues/110

## The problem

After [#90](expiry-after-submission.md) a `Submitted` job under an evaluator
with a settlement horizon could leave escrow only through `complete` or
`reject`, and both passed through the hook first. `_beforeHook` bubbled the
hook's revert before the status write, so a hook that reverted, for any
reason, left three exits closed and the refund closed too. The escrow could
not be moved by anyone. The first concrete trigger was already in the tree:
the compliance module of `PolicyRegistry` reverts by design for a poster
without a policy or above the daily ceiling.

## The options

| Option | Escrow with a reverting hook | Who can change the outcome |
|---|---|---|
| 1. Hook calls on the settlement paths tolerate a revert | settles, the failure is an event | nobody, the state machine finishes |
| 2. A last-resort exit after `expiredAt` plus a delay | refundable after a new window | the client, once the delay passes |
| 3. An owner recovery function | movable by the owner | the owner, at any time |

Option 2 opens a second clock and still has to decide who is paid. Option 3
puts the owner's key inside the escrow. Option 1 makes the code say what the
design already says: the hook's `beforeAction` and `afterAction` return
nothing the payout depends on, so a failure there has no payout meaning.

## Decision: option 1, with one strict call left strict

**`complete` and `reject` wrap `beforeAction` and `afterAction` in a
tolerant call.** A hook that reverts or runs out of its gas cap produces
`HookFailed(jobId, hook, selector, reason)` and the kernel finishes the
transition: status, ledger credits, events. The pre-settlement actions
(`setProvider`, `setBudget`, `fund`, `submit`) keep the strict call. A revert
there blocks nothing permanently, the caller can adjust and retry, and a
provider who binds an agent they do not own must see the error rather than a
silent submission without a binding.

**`resolvePayout` stays strict.** Its return value is the payee. Swallowing
its revert and falling back to the provider would reopen [#89][i89]: a buyer
who bought the receivable would lose the payout. So `complete` still reverts
with the resolver's error. What changes is the guard from #90: it stands
while its premise stands. `claimRefund` on an expired `Submitted` job under a
horizon evaluator probes the resolver with the hook gas cap; an answer with a
usable payee keeps `SettledByEvaluator`, a revert or a zero payee opens the
refund and emits `PayoutUnresolvable`. The evaluator that could settle the job
is trusted instead of the expiry; the evaluator that provably cannot is not.

[i89]: https://github.com/wienerlabs/square/issues/89

**The hook wraps the compliance module the same way.** `_checkRelease` calls
the module inside `try/catch`; a revert reads as "not verified", emits
`ComplianceCheckFailed(jobId, reason)`, and the job completes with a `0`
validation response on the ERC-8004 registry when a module is installed.
Compliance is a signal on the release, not a lock on the escrow.

## What this fixes for #27

A gating module cannot lock money by reverting, because the kernel no longer
lets it. If a policy must stop a release, the hook has one channel that the
kernel honours: `resolvePayout` returns `(payee, providerBps)`, and
`providerBps = 0` returns the whole net to the client. A verdict is a split,
never a revert. The ComplianceHook of #27 has to be written against that
contract.

## The hookless split (#110)

`_resolvePayout` short-circuits to `(provider, 10 000)` for a job without a
payout resolver and never reads `optParams`, so an arbitration split on such
a job silently paid the provider in full. The kernel could decode the split
itself, but `optParams` is deliberately the hook's format. Instead the
decision is refused where it is made: `Arbitration.vote` rejects a `Complete`
below 10 000 bps on a job whose hook does not resolve the payout
(`SplitNeedsAPayoutResolver`), and `KeeperEvaluator.finalizeDecided` refuses
to apply one as a second line. A hookless job is completed in full or
rejected, and `DecisionApplied` and `PayoutRouted` always carry the same
number.

## The bond of a dispute that can no longer complete (#101)

With the refund reopened for a dead resolver, a disputed job can reach
`Expired`. `Arbitration.settleBond` returns the bond to the disputer in that
state; the `Rejected` leg that #97 added is unreachable, because `_decide`
settles the bond before the rejection is applied, and it was removed.

## Evidence

- `SquareJob.t.sol`: `test_hook_revertNoLongerLocksTheEscrow`,
  `test_reject_toleratesAHookThatReverts`,
  `test_claimRefund_opensWhenTheResolverIsDead`,
  `test_claimRefund_staysClosedWhileTheResolverAnswers`,
  `test_hook_revertBubblesTheHooksOwnErrorBeforeSettlement`.
- `SquareHook.t.sol`: `test_complete_moduleRejectionRecordsAFailedValidationAndStillReleases`,
  `test_gasLimit_aRunawayComplianceCheckCannotBlockSettlement`.
- `Arbitration.t.sol`: `test_vote_splitNeedsAPayoutResolver`,
  `test_settleBond_returnsTheBondWhenTheJobExpiresUnderADeadResolver`.
- `KeeperEvaluator.t.sol`: `test_finalizeDecided_refusesASplitItCannotRoute`.
