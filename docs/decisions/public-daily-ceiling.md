# The daily ceiling is public, the policy behind it is not

**Status:** decided in [#26][i26]. Binds `contracts/src/PolicyRegistry.sol` and
the compliance module in [#27][i27].

[i26]: https://github.com/wienerlabs/square/issues/26
[i27]: https://github.com/wienerlabs/square/issues/27

## The decision

`PolicyRegistry` stores two things per institution: a Poseidon commitment to its
spending policy, and a **daily ceiling in plain USDC base units**. The ceiling
is readable by anyone.

This is a deliberate exception to the rule that the policy stays private, and it
is worth writing down rather than discovering in a storage dump.

## Why there has to be one

The circuit already enforces a daily ceiling. Rule 2 is

```
daily_spent_before + amount <= max_daily
```

and `max_daily` is a private input — it never reaches the chain, which is the
whole point. But `daily_spent_before` is public signal 5, and it is supplied by
whoever builds the proof.

A prover free to claim `daily_spent_before = 0` on every payment makes rule 2
vacuous. Each payment individually fits under a ceiling it never approaches, and
the daily cap enforces nothing at all — the same shape of failure as aperture's
counter, which was deferred to a Solana transfer hook that never fired for
legacy SPL mints.

So the chain needs its own answer to "what has this institution already spent
today". `recordSpend` returns that number, and #27 refuses a proof whose signal
5 disagrees with it. Without the counter the private ceiling is decoration.

## Why the ceiling next to it is public

Given the counter, a public ceiling costs one extra storage slot and buys a
check that does not depend on the proof being well formed at all. If the
compliance module is misconfigured, or a future module has a bug, or the proof
system is replaced, the registry still refuses to let a day's spending pass a
number the institution set itself.

What it discloses is one integer: the institution's outer daily ceiling. It does
not disclose the per-transaction ceiling, the token whitelist, the blocked
addresses, the allowed categories, or the time window — all of which stay inside
the commitment and are only ever proved, never published.

The two ceilings are not required to be equal, and in general the private
`max_daily` should be the tighter of the two. The public one is a floor under
the failure modes of everything above it.

## The alternative, and why not

The ceiling could live only inside the commitment, with the registry holding
just the counter. That publishes nothing.

It also means the *only* thing standing between an institution and an unbounded
day is the correctness of the compliance module and the soundness of the proof
system. This repository's trusted setup is a demo setup until [#16][i16]
completes, and even afterwards a compliance gate whose every failure mode is
silent is not the one an institution should have to accept. One public integer
is a cheap price for a check that survives the rest being wrong.

[i16]: https://github.com/wienerlabs/square/issues/16

## Fail closed

A ceiling of zero authorises **no** spending. The other reading — zero means
unlimited — turns a field somebody forgot to set into a hole in the ceiling, and
that is the wrong direction for this contract to be wrong in.

### What fail-closed costs, in this codebase

Failing closed is right in isolation. It is not free here, and the cost has to be
written down rather than discovered.

`recordSpend` reverts with `NoPolicy` when a poster never committed one, and with
`DailyLimitExceeded` when the ceiling would be passed. Either propagates through
`IComplianceModule.checkRelease` into `SquareHook.beforeAction` and out of
`SquareJob.complete`, which reverts before any state change.

And `setPolicy` is keyed by `msg.sender` with no access control, deliberately —
that is what makes cross-writing impossible. The same property lets a client
lower its own ceiling to zero at any moment, for the price of one transaction.

Put next to [#90][i90], where an expired job refunds the client in full, that
composes into a way to refuse to pay for delivered work:

1. the agent delivers and the job is submitted;
2. the client sets its ceiling to zero, or never wrote a policy at all;
3. every `complete` reverts, permanently;
4. the job reaches expiry and `claimRefund` returns the whole budget.

Nothing in this contract is wrong on its own, and the invariant suite shows the
counter itself is never overspent. What is wrong is the composition, and
**[#90][i90] has to be decided before this mechanism is switched on**, because
the fix belongs there: `complete` reverting must not be a route to a refund.

Both halves are in the test suite rather than only here —
`test_theClientCanZeroItsOwnCeilingAndBlockEveryRelease`, and the invariant that
found the same lever unprompted on its first run.

[i90]: https://github.com/wienerlabs/square/issues/90

## The day is a calendar day

`block.timestamp / 86400`, matching the circuit's `day_index`. Not a rolling 24
hours: an institution can spend the whole ceiling at 23:59:59 and the whole of it
again at 00:00:00 — twice the daily limit inside one second, and within policy.

That is not an oversight and it is not free to change. The circuit's time
decomposition means the same thing by a day, and the counter and rule 2 have to
be on one clock; a rolling window here would put them on two. Bounding the burst
is the per-transaction ceiling's job, and that one stays private inside the
commitment. `test_recordSpend_theCeilingIsPerCalendarDayNotPerRollingDay` asserts
the behaviour so it cannot change by accident.

## What "never published" is actually worth

The claim above — that the per-transaction ceiling, the whitelist, the blocked
addresses, the categories and the time window are only ever proved and never
published — rests on the policy commitment hiding them.

**It did not, until [#45][i45].** The commitment was `Poseidon(8)` over eight
policy values with no nonce, and a commitment without a nonce hides its preimage
only as far as the preimage is hard to guess. Taking the eight in turn as they
stood:

| Input | Guessability |
|---|---|
| `max_daily` | **Free.** It is `dailyLimit`, published by this registry. |
| `time_field` | at most `2 × 128 × 24 × 24 = 147,456` values |
| the three list hashes | empty and single-entry lists have a small set of well-known images |
| `max_per_tx` | a round USDC figure, in practice |
| `operator_id_field`, `policy_id_field` | everything else rested here |

So the secrecy of the whole policy reduced to the entropy of two identifiers —
adequate if they were random UUIDv4s, which was a requirement nobody had
written down. That was [#98][i98].

**It holds now.** Each field sits behind its own salt:

```
leaf[i] = Poseidon(3)(i, salt[i], value[i])
root    = Poseidon(8)(leaf[0] … leaf[7])
```

The root is still one `Poseidon(8)`, so this registry, the verifier and the
public signal layout are unchanged — `commitment` holds the same kind of value
it always did. What changed is that guessing a field no longer opens it: the
salts carry 254 bits, and `services/prover/test/disclosure.test.js` shows the
difference by searching two thousand plausible ceilings, finding the unsalted
leaf and not the salted one.

Publishing `dailyLimit` is therefore no longer a crack in the commitment. It is
what it was meant to be: one integer, disclosed on purpose, next to a commitment
that discloses nothing else.

The same construction is what makes selective disclosure possible at all —
`open()` proves one field against the commitment this registry holds — which is
[#45][i45]'s subject and is documented in
[circuits/README.md](../../circuits/README.md#the-policy-commitment).

[i45]: https://github.com/wienerlabs/square/issues/45
[i98]: https://github.com/wienerlabs/square/issues/98
