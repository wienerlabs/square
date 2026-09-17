# The record a settlement leaves behind

Square writes one ERC-8004 validation record per settled job, under the tag
`square.settlement`, and its `responseHash` commits to the payment that
produced it. This document says what that record means, how to check one, and
why the shape is what it is.

## The claim

> Every reputation record Square writes has been paid for. The record exists
> because money moved, and forging one costs the job it names.

That is a narrow claim and it is worth being precise about how narrow. The
record does not say the work was good. It says a client funded a job, a provider
delivered, an evaluator settled it, and the kernel credited a named payee a named
amount in the same transaction that wrote the record.

## Why this is worth writing down

An empirical study of the ERC-8004 ecosystem published in 2026
([arXiv:2606.26028](https://arxiv.org/abs/2606.26028)) measured what the
reputation layer actually holds. Of the feedback records on Ethereum, 98.7 per
cent carry no payment proof and no task linkage; on BNB Smart Chain the figure is
100 per cent and on Base 99.3. The median cost of writing one is 0.0027 dollars,
against a median agent payment volume 259 times larger. On Base, 90.6 per cent of
reviewers share funding provenance with other reviewers.

The study names four failures. Square's answer to each is a property of the
contract rather than a policy:

| Failure the study names | What Square does |
|---|---|
| C1, no unified scale: values range over 0 to 100, booleans and unbounded revenue figures | One tag, `square.settlement`, means one thing. The response is 100 when the payee was credited and 0 when they were not. Nothing else is written under it |
| C2, a single extreme rating moves any average | Square writes records; it does not publish an aggregate. An aggregator that wants robustness can compute it over a set where every member is checkable |
| C3, ratings carry no verifiable interaction | The record is written by the hook inside `complete`, in the same transaction that credits the payee, and the commitment names the payee, the amount and the token |
| C4, a record costs fractions of a cent to forge | Producing one requires funding a job, waiting out the challenge window and settling it. The cost of a record naming an amount is that amount |

## What the commitment covers

`SquareHook` hashes seven values into the `responseHash` it writes:

```
keccak256(abi.encode(
  jobId,
  payee,
  amount,
  token,
  screening,
  complianceOutcome,
  screeningOutcome
))
```

- `payee` is the address the kernel credited, which is the receivable's buyer when
  the claim was sold and the provider otherwise.
- `amount` is what that address received: the net payout after the platform and
  evaluator fees, multiplied by the split the evaluator or the arbiters set. A
  refused release is 0.
- `token` is `SquareJob.paymentToken()`.
- `screening` is the commitment to the sanctions record the verdict read, or zero
  when no screening registry is installed.
- The two outcomes are 0 for a check that did not run, 1 for passed and 2 for
  failed, for the compliance module and the screening registry in that order.

A commitment on its own cannot be checked by a reader, so the preimage is emitted
beside it as `EvidenceRecorded`. Anyone can recompute the hash from the event and
compare it with what the registry holds.

## How to check a record

```bash
cd packages/core && npm run check:evidence -- 12 13 14
```

For each job the script reads three independent things and compares them:

1. the `EvidenceRecorded` event, and whether its own fields hash to the commitment
   it carries
2. the `responseHash` the ValidationRegistry holds for that job's validation
   request
3. `SquareHook.settlementFacts(jobId)`, which reads the payee, the amount and the
   token back out of the kernel's own state

A record passes only when all three agree. `CHAIN_ID` and `RPC_URL` choose the
network and `SQUARE_DEPLOYMENT_FILE` overrides the address record, the same way
`check:selectors` takes them.

## Why a record is written even when no check ran

Before this, a validation record existed only where a compliance module or a
screening registry was installed, and the response was the gate's verdict. On the
shared Arc stack neither is installed, so no record had ever been written there.

Two things follow from writing one for every settled job instead. The claim above
has instances on a stack with the gate off, which is the stack that reaches a
network first. And the tag means one thing rather than two: the record is about
the settlement, and the gate's verdict is a field inside it rather than a
precondition for its existence.

The response follows the money for the same reason. A release the mandate refused
credits the payee nothing, and a record that said 100 there would be describing a
check rather than a payment.

## What is deliberately not in the record

The deliverable is not, and neither is any description of the work. The record
names an amount and the parties to it. A reader who wants to know what was
delivered has the job's `deliverable` hash on the kernel and whatever the parties
agreed off chain; the ValidationRegistry is not the place for it.

Nothing personal is in the commitment. `screening` is itself a commitment to a
record held elsewhere, for the reason
[travel-rule.md](travel-rule.md) gives: Square carries no personal data, on chain
or off.

## When the reads fail

`settlementFacts` is an external call so that the hook can catch it. If the
kernel reads that build the evidence revert, the hook emits `EvidenceUnreadable`
and writes no validation record at all. Settlement is untouched and the
reputation write still stands. A record that cannot be made honestly is not made,
which is the same rule as
[hook-failure-modes.md](../decisions/hook-failure-modes.md): the hook informs and
never vetoes.
