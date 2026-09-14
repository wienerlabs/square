# A delegating agent's budget is the institution's policy, read from the chain

**Status:** decided and implemented for [#38][i38]. Binds
`packages/hosted/src/allowance.ts`; rests on `PolicyRegistry` ([#26][i26]) and
the compliance module ([#27][i27]).

[i38]: https://github.com/wienerlabs/square/issues/38
[i26]: https://github.com/wienerlabs/square/issues/26
[i27]: https://github.com/wienerlabs/square/issues/27

## The question

A hosted agent that delegates hires other agents with money. [#38][i38] asked for
a budget on that spending, and noted that [#26][i26] had already put a spending
limit on chain: `PolicyRegistry` holds, per institution, a daily ceiling and the
counter the compliance module advances at every release. Two limits on the same
money, kept by two parties, is the situation the issue said must not exist.

The predecessor had exactly that. aip-beta's orchestrator drew on an
`agent-budget` table in Supabase: a balance the owner topped up, reserved per
step and refunded on failure, with a per-step platform fee charged into it. The
chain saw none of it, and nothing tied the balance to any policy the institution
had committed to.

## The decision: one ceiling, one counter, one reservation

**There is one limit, and it is the policy's.** `PolicyRegistry.dailyLimit`,
keyed by the wallet the agent delegates from, is the ceiling; `spentToday`,
which the registry advances when escrow is released to a provider, is the
count. The hosted agent stores neither. It reads both from the registry before
every delegation and refuses to fund a job that would put the day past the
ceiling.

**The hosted agent keeps a reservation, not a limit.** Escrow moves at funding
and the counter moves at release, and between the two a delegated job is money
the ceiling has to be read as already spoken for. So the agent remembers the
jobs it has funded and the chain has not settled, and subtracts them:

```
available = dailyLimit - spentToday - inFlight
```

`inFlight` is derived, not authoritative. Every read asks the chain for each
in-flight job's record and drops the ones it shows `Completed`, `Rejected` or
`Expired`; a release moves the amount from `inFlight` into `spentToday` on the
same ceiling, a refund or an expiry drops it. A restart loses at most the
reservation of jobs still in flight, never the ceiling or the count, and a host
that will not lose even that passes the job ids back in.

**Why the counter cannot be the whole answer.** The registry counts at release,
on the day of the release, because that is when money leaves escrow and when a
proof can be checked against it. A delegating agent funds days ahead of that. A
budget that only looked at `spentToday` would let an agent fund a week's worth
of jobs in an hour, every one within the ceiling on the day it was funded, and
have them release together on a day whose ceiling they exceed. The reservation
is pessimistic on purpose: it treats every in-flight release as if it landed
today.

**Why a per-job cap is not a second limit.** `delegation.maxPerJob` in a hosted
configuration bounds one job. It is a slice of the same allowance: a hire is
refused when it exceeds the cap or when it exceeds what the policy has left, and
neither check knows a number the other does not read from the registry.

**No policy is no allowance.** `PolicyRegistry` treats a zero commitment as
authorising nothing ([public-daily-ceiling.md](public-daily-ceiling.md), fail
closed), and so does the allowance: a wallet without a policy may delegate
nothing, and is told so before any escrow moves. The predecessor's balance had
no such floor; a wallet with a balance and no policy could spend it.

**What the model is told.** Every refusal goes back to the model as the tool's
result, in words with the numbers: the ceiling, what was released today, what
is in flight on how many jobs, what is left. The model can say so to the client
instead of trying again.

## Where the counter does and does not move

`spentToday` advances only through the compliance module, which `SquareHook`
calls at release when one is installed. On the local stack it is installed only
on request (`INSTALL_COMPLIANCE_MODULE=true`), because a module in place makes
every completion need a proof; on Arc Testnet the hook of the 2026-09-09 stack
carries no module yet ([#27][i27] installs it). Where the module is absent the
counter stays at zero, and the allowance is the ceiling less what is in flight:
the chain's own reading, not a substitute for it. The allowance never invents a
count the registry did not make; when the module lands, the same code reads the
count it makes.

## What this does not cover

x402 per-call payments. An agent paying another per call over x402 moves USDC
directly, with no escrow and no release, so the registry never sees it. A hosted
agent therefore delegates through escrow only; `square_call`-style payments are
a caller's tool (`@squaresdk/mcp`), not a delegation. Counting x402 spend
against the ceiling would need the hosted agent's ledger to be the source of
that count, which is the second limit system this decision exists to refuse.

Delegation by an agent whose wallet is not the institution's. The allowance is
keyed by the delegating wallet because the registry is: an institution that
runs several agents from one wallet gives them one allowance, which is what
[#26][i26] decided spending authority means.
