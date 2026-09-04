# Disclosure

What this project says about itself when the honest answer is unflattering.

Right now there is one such thing: the phase-2 trusted setup inherited from
[aperture](https://github.com/wienerlabs/aperture) is a demo — one contribution,
no beacon. Tracked as [#3](https://github.com/wienerlabs/mandate/issues/3),
lifted by [#16](https://github.com/wienerlabs/mandate/issues/16).

| File | What it is |
|---|---|
| [zk-setup-status.md](./zk-setup-status.md) | The statement, the machine-checked evidence behind it, and the wording every other surface quotes. Start here. |
| [surfaces.md](./surfaces.md) | The five surfaces #3 names, what the audit found on each, and the exact copy that replaces it. |
| [forbidden-phrases.txt](./forbidden-phrases.txt) | The enforced pattern list. CI reads this file directly; it is the only place to edit. |
| [guard-fixtures/](./guard-fixtures/) | Lines the guard must catch, and lines it must never catch. |
| [patches/](./patches/) | Unified diffs against `wienerlabs/aperture`, verified to apply cleanly. |

## Why this directory is exempt from the scan

`.github/scripts/check-forbidden-phrases.sh` skips `docs/disclosure/`. It has
to: the audit record in `surfaces.md` quotes the claim it found, and the patches
under `patches/` carry it on their `-` lines — that is the claim being deleted,
not made. Scanning here would flag the removal. The directory is small enough to
read in full during review.

Everything else in the repository is scanned.

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
