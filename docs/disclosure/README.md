# Disclosure

What this project says about itself when the honest answer is unflattering.

Right now there is one such thing: the trusted setup inherited from
[aperture](https://github.com/wienerlabs/aperture) is a demo in **both** phases
— a locally generated powers of tau, and a phase 2 with one contribution and no
beacon. Tracked as [#3](https://github.com/wienerlabs/square/issues/3), lifted
by [#16](https://github.com/wienerlabs/square/issues/16).

| File | What it is |
|---|---|
| [zk-setup-status.md](./zk-setup-status.md) | The statement, the machine-checked evidence behind it, and the wording every other surface quotes. Start here. |
| [surfaces.md](./surfaces.md) | The five surfaces #3 names, what the audit found on each, and the exact copy that replaces it. |
| [forbidden-phrases.txt](./forbidden-phrases.txt) | The enforced pattern list. CI reads this file directly; it is the only place to edit. |
| [guard-fixtures/](./guard-fixtures/) | Lines the guard must catch, and lines it must never catch. |
| [patches/](./patches/) | Unified diffs against `wienerlabs/aperture`, verified to apply cleanly. |

## How exceptions work

Prose in this directory is scanned like everything else. A line that quotes a
forbidden claim on purpose carries the `ci-allow-phrase` marker, which is main's
mechanism: marking the line rather than exempting the file keeps the exception
visible in the diff that introduces it.

Three paths cannot use the marker and are skipped outright — `patches/`, because
a marker inside a diff line would corrupt the patch and the wording there is on
`-` lines being deleted; `guard-fixtures/`, where every line is a forbidden
claim by construction and the self-test is what governs it; and
`forbidden-phrases.txt` itself, whose comments quote the wording each pattern is
for. The script lists them with the reason beside each.

## Working on this

```bash
.github/scripts/check-forbidden-phrases.sh              # self-test, then scan
.github/scripts/check-forbidden-phrases.sh --self-test  # fixtures only
.github/scripts/check-forbidden-phrases.sh --list       # active patterns
```

Adding a pattern: put it in `forbidden-phrases.txt`, add a line it must catch
to `guard-fixtures/violations.txt`, and — if the pattern is at all broad — add
the honest sentence it must *not* catch to `guard-fixtures/allowed.txt`.

That second fixture file is not decoration. The guard that shipped with the
repository skeleton flagged the repository's own disclaimer and had been red
since the first commit, so the rule it enforced was never actually enforced. A
guard that blocks accurate disclosure pushes people towards vague wording,
which is the outcome this whole directory exists to prevent.

## Checking the evidence

```bash
git clone https://github.com/wienerlabs/aperture.git ../aperture
node circuits/scripts/inspect-zkey-setup.mjs \
  ../aperture/services/prover-service/artifacts/payment.zkey
```
