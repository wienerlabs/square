# Who has to look: a review gate on the code that moves money

**Status:** decided for [#108][i108]. Binds `.github/CODEOWNERS` and
`docs/ci/branch-protection.json`; applied to `main` by the command in
[docs/ci.md](../ci.md).

[i108]: https://github.com/wienerlabs/square/issues/108
[i77]: https://github.com/wienerlabs/square/pull/77
[i97]: https://github.com/wienerlabs/square/pull/97
[i100]: https://github.com/wienerlabs/square/issues/100
[i78]: https://github.com/wienerlabs/square/pull/78

## The record

[#78][i78] made the checks run before a merge. Nothing made a person look. The
thirteen pull requests in the issue's table, #78 itself among them, merged with
zero formal reviews; one was [#77][i77], two hundred and forty-one files and
the whole escrow stack, which
went to the testnet with four critical bugs, and [#97][i97], the fix, which
went in unreviewed too and opened [#100][i100]. Review did happen, in comments,
and the findings were taken; but a comment does not stop a merge, and six months
later "who looked at this" has no answer GitHub can give.

[#108][i108] put four questions. The answers:

## 1. Is a review required? For the money code, yes.

A pull request that touches `contracts/` or `circuits/` needs one approving
review from a code owner who did not write it. Those two directories are where
the four critical bugs were, and they are the slowest-changing and the most
expensive-to-get-wrong code in the repository: an escrow that pays the wrong
party, a circuit that accepts the wrong proof. A human reading the diff is the
cheapest control there is against that, and it is the one that was missing.

## 2. For everyone, or for some paths? Some paths.

Everything else merges on green checks alone, as it does today. Documentation,
the SDK packages, the services, the application: the tests are the gate, and a
review requirement across the board would have every documentation pull request
wait on one of three people. The cost the issue named, "one of the other two"
with mostly disjoint areas, is paid only where the stakes justify it.

GitHub does this with `CODEOWNERS` and "require review from code owners":
`required_approving_review_count` stays at zero, so a pull request that touches
no owned path needs no approval, and one that does needs an approval from an
owner of that path. `packages/core`, which the issue also floated, stays out
for now: it is SDK code over the contracts, covered by the anvil suite, and
its failure mode is a broken client rather than a wrong payment. Adding it is
one line in `CODEOWNERS`.

## 3. Who reviews whom? The second name on each line.

```
/contracts/  @kh0ra @mehmethayirli
/circuits/   @MuhammedAkinci @mehmethayirli
```

kh0ra writes the contracts, Akıncı the circuits, and neither can approve their
own pull request, so a rule naming one owner per directory would make that
owner's every change wait on nobody and fail closed. The second owner is the
reviewer of the first. It is a real cost: a contracts pull request now waits
until mehmethayirli has read it. It is the cost the issue asked to weigh, and
for these two directories it is worth paying; for the rest of the repository it
is not, which is answer 2.

`dismiss_stale_reviews` is on: an approval covers the commits it was given on,
and a push after it needs another look. `require_last_push_approval` is off,
since the author is the one pushing and cannot approve anyway.

## 4. Does `enforce_admins: false` stay? Yes, and using it is a statement.

Every collaborator is an administrator, so admin bypass is not a privilege of a
few; it is a valve everyone holds. It stays, because a required check that
stops reporting, a reviewer who is unreachable for a week, or a fix that has to
land tonight are all real, and the alternative is an administrator undoing the
protection itself, which is the same bypass with less trace. What changes is
the reading: merging a `contracts/` or `circuits/` change through the bypass is
no longer the default it was for thirteen pull requests, it is an exception,
and the pull request should say why.

## Applying it

The order [docs/ci.md](../ci.md) already fixes for new checks holds here: merge
this pull request first, so `CODEOWNERS` is on `main`, then re-apply the
payload:

```bash
gh api -X PUT repos/wienerlabs/square/branches/main/protection \
  --input docs/ci/branch-protection.json
```

Then check both halves, because the API accepts a review count of zero and the
web form does not offer it, and the combination is what this decision rests on:
a documentation-only pull request must show no review requirement, and a pull
request touching `contracts/` must show "Review required" naming a code owner.
If GitHub turns out to require an approval on every pull request under this
payload, the fallback is `required_approving_review_count: 1` for everything,
which is answer 1 without answer 2, and this document gets rewritten to say so.
