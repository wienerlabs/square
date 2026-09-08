# Expiry does not undo a submission under an optimistic evaluator

**Status:** decided in [#90][i90]. Binds [#89][i89] (the receivable market reads the
same rule), [#91][i91] (the bond of a dispute that can no longer complete) and
[#92][i92] (the gas ceiling the expiry path shares with every other path).

[i89]: https://github.com/wienerlabs/square/issues/89
[i90]: https://github.com/wienerlabs/square/issues/90
[i91]: https://github.com/wienerlabs/square/issues/91
[i92]: https://github.com/wienerlabs/square/issues/92

## The problem

`claimRefund` was open to anyone once `expiredAt` passed, on a `Funded` job and
on a `Submitted` one alike. A provider who submitted on time and then waited
through the challenge window could still lose the whole escrow to a refund if
the expiry landed before a keeper finalized. Worse, a client could open a
dispute in the last seconds of the challenge window, let it lapse, and race
`claimRefund` against `finalizeDecided`. `createJob` already refused an expiry
inside the evaluator's `settlementHorizon`, so the horizon was a promise the
kernel did not keep at the end.

## The options

| Option | Provider on time | Client liveness | Cost |
|---|---|---|---|
| 1. Keep expiry as the outer bound | can lose a finished job to a refund | always has an exit | none, the bug stays |
| 2. A submission freezes the expiry for every evaluator | safe | none: an EOA evaluator that walks away locks the escrow forever | a new liveness hole |
| **3. Evaluators with a horizon settle; the rest keep the expiry** | safe when a horizon exists | kept wherever nobody else can crank | one branch in `claimRefund`, one margin in the horizon |

## Decision: option 3

`claimRefund` refuses a `Submitted` job whose evaluator reports a non-zero
`settlementHorizon()`, with `SettledByEvaluator()`. Every path that settles a
job under `KeeperEvaluator` is permissionless: `finalize` after the window,
`lapse` after `resolveBy`, `finalizeDecided` once the arbiters decided or the
dispute lapsed. Nobody has to trust a counterparty for liveness, so the
horizon can be trusted instead of the expiry.

A `Submitted` job under an evaluator that has no horizon (an EOA, a custom
contract that does not implement `ISettlementHorizon`) keeps the old rule:
after `expiredAt`, anyone may refund the client. A `Funded` job keeps it too;
nothing was delivered.

The horizon gains a margin. `settlementHorizon()` is now
`challengeWindow + disputeWindow + finalizeGrace`, and `createJob` keeps
refusing an expiry inside it. The grace is the room a keeper needs after
`resolveBy` to send `lapse` and `finalizeDecided`; it is owner-configurable,
never zero, and reported by `finalizeGrace()`.

## What moves with it

- `Arbitration.settleBond` is permissionless. It returns the bond to the
  disputer when the job is `Expired` or `Rejected`, since no vote can complete
  it any more, and otherwise settles as before once the job is `Completed`.
  A dispute that lapses is cranked by the keeper, not by the client (#91).
- `ClaimMarket` lists only jobs whose hook routes the payout to this market,
  checked through `IPayoutResolver.payoutMarket()`, and pays the provider
  read from `SquareJob.providerOf` rather than the historical payee (#89).
- `createJob` caps the description at 256 bytes, so the widest job stays under
  the hook gas ceiling on every settlement path (#92).
- The keeper cranks `lapse` and warns a day before an expiry it cannot
  prevent. The app hides `Claim refund` on a `Submitted` job the keeper
  evaluates and says why.

## Evidence

- `SquareJob.t.sol`: `claimRefund` refunds a funded job after expiry, refuses
  a submitted job under the keeper with `SettledByEvaluator`, still refunds a
  submitted job under an evaluator without a horizon.
- `KeeperEvaluator.t.sol`: a last-second dispute cannot turn into a refund;
  every dispute's `resolveBy + finalizeGrace` sits inside `expiredAt`.
- `invariant/ArbitrationSolvency.t.sol`: bonds are either held or
  withdrawable, terminal jobs have settled bonds, the kernel stays solvent.
