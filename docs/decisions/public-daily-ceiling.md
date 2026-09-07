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
