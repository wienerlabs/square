# A missing proof holds the escrow; only the mandate refunds

**Status**: decided for [#346][i346] on 2026-09-15; not yet built. The
contract and keeper work is [#382][i382], on the critical path before the
redeploy ([#372][i372]), so the change rides with it. Until it lands, the
hook refunds a missing proof the way it refunds a refused one.

[i100]: https://github.com/wienerlabs/square/issues/100
[i346]: https://github.com/wienerlabs/square/issues/346
[i349]: https://github.com/wienerlabs/square/issues/349
[i350]: https://github.com/wienerlabs/square/issues/350
[i353]: https://github.com/wienerlabs/square/issues/353
[i372]: https://github.com/wienerlabs/square/issues/372
[i382]: https://github.com/wienerlabs/square/issues/382

## The question

On a stack whose hook holds a compliance module, a release out of escrow
needs a proof the **client** bound to the job: that the payment, as the chain
would make it now, fits the client's committed policy. The module reads the
proof at release and answers with a split, never a revert
([compliance-gate.md](../design/compliance-gate.md), [#100][i100]): a proof
the mandate refuses pays the provider nothing and returns the whole net to
the client.

The module gives that same answer to two different situations:

| | What happened | Whose act | Today's outcome |
|---|---|---|---|
| A | A proof is bound and valid, and the mandate says no: `is_compliant` is 0, or one of the eight bindings (policy commitment, recipient, amount, token, the day's counter, the clock, the receipt hash) does not hold | the institution's mandate, speaking | the net returns to the client, the reason is on chain |
| B | There is no verdict to be had: no proof is bound, the bytes are not a proof, or the pairing fails (a proof from another key, [#353][i353]) | the institution not doing its duty, or its tooling | the net returns to the client, under the reason `malformed proof` or `invalid proof` |

A is the gate working. B is the gate paying the client for not showing up:
a client that receives the work and binds nothing gets its escrow back, and
the provider, who cannot bind a proof for a policy it does not hold, has no
recourse ([#346][i346]). Escrow was supposed to protect the provider from
exactly that.

## The decision

**A release with no verdict does not settle. Only the mandate's own refusal
returns the escrow.**

1. **Class B holds.** When the window has closed (or the arbiters have
   decided) and the job carries no proof, a malformed one, or one that does
   not verify, `finalize` and `finalizeDecided` do not settle the job: they
   revert with a named error, the job stays `Submitted`, the escrow waits.
   The client, and only the client, ends the wait by binding a proof, at
   which point the release is class A or paid. Nothing anyone else does can
   open or close that door, which is the difference from the cases
   [#100][i100] closed: there the escrow was stalled by a hook's failure,
   with no exit for the client; here the client holds the key, and the
   provider is no longer paid for the client's silence.

2. **The policy commitment is pinned at funding.** The hook records the
   client's `PolicyRegistry.commitmentOf(client)` when the job is funded,
   and the module binds `policy_data_hash` to that record rather than to
   the live one. A client cannot rewrite its mandate after delivery to turn
   a class-A refusal on; a new policy governs the jobs funded after it.
   What the mandate can still refuse at release, under the pinned policy,
   is the mandate's business: a day's ceiling spent elsewhere, a window
   that closed, a recipient that was blocked when the policy was committed.

3. **What the surfaces do.** The duty in `@squaresdk/policy` already binds a
   proof when the release is near and cranks after
   ([proof-freshness.md](proof-freshness.md), [#349][i349]); the hold never
   applies to a client that runs it. The keeper journals a held job as
   waiting on its client, not as a failure, and looks again each tick. The
   app's job page, `square_job` and the indexer name the wait for what it
   is: the client has bound no proof. Nothing here needs the provider to do
   anything it could not do before.

So the sentence the README and the agent's card can carry is: **escrow
protects the provider against everything except the institution's mandate.
A payment the mandate forbids returns to the client with the reason on chain;
a proof that is merely missing holds the escrow until the institution does
its duty.**

## What that rules out

- **Paying without a proof after a deadline** (the issue's option 1a). The
  module's guarantee is that no USDC leaves escrow on a gated stack without a
  proof that the payment fits the mandate. A deadline that pays anyway makes
  the guarantee "unless the institution waited long enough", which is no
  guarantee an institution can put in front of its auditors.
- **A provider's dispute over a refused release** (option 2). The arbiters'
  decision would still have to be paid out through the module, and a
  decision for the provider is a payment without a proof: the same hole,
  behind a bond and a vote.
- **Documenting today's behaviour and leaving it** (option 3). It would say
  that escrow on the shared testnet does not protect a provider from a
  client that binds nothing, and that every agent should trust its client's
  tooling. That is the opposite of what the escrow is for.

## What it costs

- **The stall is real, and it is the client's.** A client whose duty is down
  for a day has its escrow held for a day; binding a proof ends it. A client
  that never binds never gets the money back either, and the provider is
  never paid: withholding gains nothing, which is the point. A job the
  client has abandoned is visible on chain as such.
- **Old policies have to be kept until their jobs settle.** With the
  commitment pinned, a job funded under policy P proves against P even after
  the institution moved to P'. The duty has to say so when the pinned
  commitment is not the policy file's (`square policy prove --file` with
  the older file is the answer), which is a follow-up in `@squaresdk/policy`.
- **`claimRefund` stays closed on a submitted job the evaluator can settle.**
  It is today (`SquareJob.claimRefund` refuses with `SettledByEvaluator`
  while the hook resolves a payout), and the probe it makes has to keep
  answering "resolvable" for a job that is merely waiting for its proof,
  or the refund door would open again at `expiredAt`.

## Where it lands in the code

The exact shape is [#382][i382]'s, and the choice that matters
is that the hold is the **evaluator's**, not the hook's: a hook that reverts
is a refusal by [#100][i100]'s contract and the kernel's tolerant call, so
`resolvePayout` keeps answering a split, and `KeeperEvaluator.finalize` /
`finalizeDecided` ask the hook whether a verdict exists before they call
`complete`, and revert when it does not. Pointers, on `main` at `167dfb7`:

- `contracts/src/ComplianceModule.sol:320-333` `_verify`: `R_HOOK`,
  `R_MALFORMED` (which an empty proof falls under), `R_INVALID` are the
  class-B reasons; everything after them is class A.
- `contracts/src/ComplianceModule.sol:385`: `commitmentOf(client)` read live
  at release, the read that pinning replaces.
- `contracts/src/SquareHook.sol:140` `resolvePayout`, `:208`
  `previewVerdict`, `:250` `_checkRelease`; the `FUND_SELECTOR` branch is
  where the pin is written.
- `contracts/src/KeeperEvaluator.sol:54` `finalize`, `:89` `finalizeDecided`.
- `contracts/src/SquareJob.sol:269` `claimRefund` and `:430`
  `_payoutResolvable`.
- `services/keeper/src/run.ts`: where a revert becomes a retry, and where a
  hold becomes a journal row instead (the screening hold of #35 is the
  model).

## What this does not decide

- Whether `fund` should refuse a client that has committed no policy on a
  gated stack (today the agent refuses the job at admission, [#350][i350];
  the chain does not). It would close the same class of case one step
  earlier and is asked in [#382][i382].
- Anything about the module's key ([#353][i353]) or the ceremony; a proof
  from the wrong key is class B and holds, which is the better outcome than
  today's refund, and no more.
