# A lapsed dispute returns the bond

**Status:** decided in [#117][i117].

[i117]: https://github.com/wienerlabs/square/issues/117

## What the bond does today

`Arbitration.settleBond` routes the bond by outcome:

| Outcome | Who lost | Bond goes to |
|---|---|---|
| `Reject` | the provider | the disputer, immediately in `_decide` |
| `Complete` at 10 000 bps | the disputer | the payee |
| `Complete` below 10 000 bps | partly the disputer | the disputer |
| `Lapsed` | nobody decided | the disputer |

The provider never posts a bond and never loses one. The bond leaves the
disputer in exactly one case: the arbiters find for the provider in full. The
app and the site now say that, and nothing else.

## The question

`Lapsed` is the case where the arbiters did not decide inside the dispute
window. Returning the bond there means a dispute that ends in a lapse costs
the client only gas and the lockup of the bond for the window. Three options
were on the table: keep it and write the cost down, hand part of the bond to
the arbiter pool or the protocol, or treat a lapse as the disputer's risk and
forfeit the bond.

## Decision: keep it, and write the cost down

A lapse is the arbiters' failure to act, not the disputer's. Charging the
disputer for it would turn the bond into a tax on legitimate disputes
whenever the arbiter set is slow, which is the situation in which a client
most needs the dispute to be cheap. Paying the arbiters out of a lapsed bond
would reward the set for not deciding.

## The cost of griefing, at the deployed parameters

A client who disputes a job they intend to lose can only delay their own
provider, once per job, by at most one dispute window. The outcome of a lapse
pays that provider in full. The client pays:

- the dispute transaction, about 175 000 gas, plus the withdrawal of the
  returned bond, about 54 000 gas: at 22 gwei on Arc about 0.005 USDC;
- the bond itself, 10 percent of the budget with a floor of 1 USDC, locked
  for the dispute window (300 seconds on the testnet, 3 days in the default
  configuration);
- nothing else, because `lapse` and `finalizeDecided` are cranked by the
  keeper, whose gas the keeper fee covers.

The provider bears the delay and nothing else. That is accepted for phase 1:
the harm is bounded by one window per job and the client cannot repeat it on
the same job.

## What would change the decision

A lapse fee becomes reasonable once the arbiter set has a service level that
makes a lapse the exception rather than a possibility to design around. At
that point a fixed share of the bond, paid to the payee for the delay, is the
smallest change; it is not in the contracts today and this record is where
that trigger is written.

## Evidence

`Arbitration.t.sol`: `test_settleBond_routesTheBondInAllFourOutcomes` walks
the four outcomes on four disputed jobs and checks where every bond lands.
