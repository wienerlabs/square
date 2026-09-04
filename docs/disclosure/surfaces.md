# Surfaces: where the demo-setup disclosure has to appear

Issue [#3][i3] lists five surfaces. This file is the working record for all
five: what the audit found on each, what replaces it, and whether the change
has landed.

The wording all of it quotes from is [zk-setup-status.md](./zk-setup-status.md).
Change that file first, then propagate here.

[i3]: https://github.com/wienerlabs/mandate/issues/3

| # | Surface | Audit result | Deliverable | Landed |
|---|---|---|---|---|
| 1 | Deck | No deck file exists in any repository reachable from this project | Slide copy, below | Copy ready |
| 2 | Three old repositories' READMEs | 5 claims in `aperture`; `aip-beta` and `covenant` clean | 2 applicable patches | Patches ready |
| 3 | Presentation materials | No artifact exists in any reachable repository | Disclosure block, below | Copy ready |
| 4 | 1:1 notes / talk track | No artifact exists in any reachable repository | Spoken script, below | Copy ready |
| 5 | a-perture.com | 3 claims, live now, served from `aperture/dashboard/src/app/docs/page.tsx` | 1 applicable patch | Patch ready |

"Copy ready" means the text is written and approved here; applying it to a deck
or a website deployment is a publishing step outside this repository. "Patches
ready" means a unified diff under [`patches/`](./patches/) applies cleanly to
the upstream repository at the commit named in the patch header.

---

## The audit

Every line below was found by grep against a fresh clone, not recalled. The
`aperture` findings are at commit `main` as of the audit; the a-perture.com
findings were additionally confirmed against the live site.

### aperture — 5 claims, all patched

| File | Line | Found | Why it is wrong |
|---|---|---|---|
| `README.md` | 14 | `- **Production ZK proofs** -- Circom + snarkjs Groth16 proofs...` | The headline feature claim. Says production outright. |
| `README.md` | 49 | `...live transactions on Solana Devnet demonstrating the system in production.` | Devnet transactions are not production operation. |
| `README.md` | 308 | `Trusted setup:   shipped under circuits/payment-prover/build/payment_final.zkey` | Not false, but silent. A reader learns where the file is and nothing about what stands behind it. Silence here is the failure mode #3 is about. |
| `circuits/payment-prover/README.md` | 27 | `- **Phase 5:** production trusted-setup ceremony (Hermez ptau drop-in), ...` | Phases 1–4 above it are each marked `(complete)`. Phase 5 carries no marker, so the list reads as nearly finished. |
| `circuits/payment-prover/README.md` | 103 | `## Production trusted setup` | A section heading asserting the thing that has not happened. |

Patches: [`patches/aperture-README.patch`](./patches/aperture-README.patch),
[`patches/aperture-circuits-payment-prover-README.patch`](./patches/aperture-circuits-payment-prover-README.patch).

Already correct, left alone: `programs/verifier/src/groth16_vk.rs:18-21`
already records that phase 1 is Hermez with 54 contributors and a beacon while
"Phase 2 contribution is single-party (dev) for now". That comment is the only
place in the three repositories that got it right before this issue.

### aip-beta — clean

No zero-knowledge claim of any kind. The single grep hit is
`programs/aip-escrow/Cargo.lock`, which names the transitive dependency
`solana-zk-token-sdk`. Nothing to change.

### covenant — clean for this issue

Covenant's proofs come from a separate SP1 word-count circuit
(`circuits/word_count/`, Rust/SP1). SP1 is STARK-based and has no phase-2
trusted setup, so the failure described in #3 does not apply to it, and no
"production" claim about proofs appears in `covenant/README.md`. Nothing to
change.

### Adjacent findings, deliberately not changed

Two lines claim production-readiness about things other than ZK. They fall
outside the literal scope of #3 and were recorded rather than folded in
silently:

- `aperture/sdk/aperture-sdk/README.md:3` — "Production-ready TypeScript SDK".
- `aperture/scripts/deploy/DEPLOY.md:4` — "bu kılavuzu çalıştırmak production-ready".

Both describe an SDK and a deploy runbook whose only backend is a Devnet
deployment gated by the demo setup, so the wording is misleading by
association even though neither sentence mentions ZK. Raise it on #3 if it
should be pulled in.

### CI findings

Two failures in `.github/workflows/security.yml` predate this issue and were
found while working on it. Both are recorded in the pull request; only the
first is fixed here.

1. The `forbidden strings` job had been failing on every run since the first
   commit, because its grep flagged `README.md:21` — the repository's own
   demo-setup disclaimer, which contained the literal phrase it was written to
   catch. The guard that was supposed to enforce #3 had never once passed.
2. The `secret scan` job fails with `[wienerlabs] is an organization. License
   key is required.` gitleaks-action requires a `GITLEAKS_LICENSE` secret for
   organisation repositories. Not fixed: it needs a licence key or a decision
   to move to a different scanner, neither of which belongs in #3.

---

## 1. Deck

Insert as its own slide, placed immediately after whatever slide first shows a
proof or the word "zero-knowledge". It goes before the architecture slides, not
in an appendix.

> ### The trusted setup is a demo
>
> Groth16 needs a two-phase setup. Ours is half done, and we will say which
> half.
>
> - **Phase 1 — sound.** Polygon Hermez perpetual powers of tau. 54
>   contributors, public beacon. Reused unchanged.
> - **Phase 2 — demo.** One contribution. No beacon. Whoever held that entropy
>   could forge a proof for any statement.
>
> A public multi-party phase-2 ceremony is scheduled. Until it completes and
> its verifying key is deployed, nothing here carries a production assurance
> claim — and we are not asking anyone to put value behind it.
>
> `node circuits/scripts/inspect-zkey-setup.mjs payment.zkey` → `contributions 1, beacon no`

Speaker note for that slide:

> This is the slide people expect us to leave out. Phase 1 is genuinely fine —
> it is the Hermez ceremony, 54 contributors, and we did not touch it. Phase 2
> is the circuit-specific half and it has one contribution and no beacon. We
> are running the real ceremony; that is issue 16 and it is on the schedule. We
> will not describe this as production until it is done.

## 2. Three old repositories' READMEs

Apply the patches under [`patches/`](./patches/). Each was generated against a
clean clone and verified with `git apply --check`:

```bash
git clone https://github.com/wienerlabs/aperture.git
cd aperture
git apply --check ../mandate/docs/disclosure/patches/aperture-README.patch
git apply         ../mandate/docs/disclosure/patches/aperture-README.patch
git apply         ../mandate/docs/disclosure/patches/aperture-circuits-payment-prover-README.patch
git apply         ../mandate/docs/disclosure/patches/aperture-dashboard-docs-page.patch
```

`aip-beta` and `covenant` need no change; see the audit above.

Note that these patches point at `circuits/scripts/inspect-zkey-setup.mjs` in
*this* repository. Aperture is being archived under [#5][i5]; the tool
deliberately lives here rather than being copied into a repository that is about
to freeze.

[i5]: https://github.com/wienerlabs/mandate/issues/5

## 3. Presentation materials

Any deck, one-pager, PDF or recorded talk that mentions proofs carries this
block. It is short enough to fit a footer and specific enough to be checkable:

> **Trusted setup: demo.** Phase 1 is the Polygon Hermez powers of tau (54
> contributors, public beacon) and is sound. Phase 2 has one contribution and
> no beacon — a demo, not a ceremony. The public phase-2 ceremony is scheduled;
> until it completes, no production assurance claim applies.
> Verify: `github.com/wienerlabs/mandate` → `docs/disclosure/zk-setup-status.md`

Rules for these materials:

- Phase 1 is never cited alone. Wherever "54 contributors" appears, phase 2
  appears in the same sentence or the one after it.
- Proving time, proof size and gas may be presented as measurements. They are
  not evidence of assurance and are not placed under a heading that implies it.
- No slide, caption or chart label uses the word "production" about the ZK
  layer while [#16][i16] is open.

[i16]: https://github.com/wienerlabs/mandate/issues/16

## 4. 1:1 notes and talk track

Raise it before the other side does. The moment to say it is the first time
proofs come up, not when someone asks how the setup was generated.

**If they ask nothing:**

> One thing I want to flag before you find it. Groth16 has a two-phase trusted
> setup. Phase 1 we inherited from the Polygon Hermez ceremony — 54
> contributors, public beacon, that half is fine and we are reusing it
> untouched. Phase 2 is circuit-specific and right now it has a single
> contribution with no beacon. That means whoever ran it could forge a proof.
> We are treating it as a demo and we are running the real ceremony — public,
> multi-party, beacon announced in advance, transcripts published. Until that
> lands we are not claiming production assurance for any of it.

**If they ask "so are the proofs real?":**

> The proofs are real and they verify on-chain — that part is not marketing.
> What the demo setup costs us is unforgeability: a verifying proof means the
> prover knew a valid witness, *or* held the phase-2 entropy. The circuit is
> doing what it says. The setup behind it is not yet trustless.

**If they ask "when is the ceremony?":**

> The circuit has to freeze first — a change after the ceremony invalidates the
> zkey and we would run it twice. That is issue 14. Issue 15 is the invitation
> list, calendar and beacon source, and it is already moving in parallel. Issue
> 16 is the ceremony itself. We would rather have you in it than take our word
> for it afterwards.

**Do not say:** that the setup is fine because Hermez had 54 contributors; that
it is "good enough for a demo" in a tone that implies it is nearly good enough
for more; or that the ceremony is "basically a formality".

## 5. a-perture.com

The site is the Next.js app in `aperture/dashboard/`, deployed from the
repository root `vercel.json`. The claims are on `/docs` and were confirmed
live during the audit:

```console
$ curl -sL https://a-perture.com/docs | grep -o 'production-grade'
production-grade
$ curl -sL https://a-perture.com/docs | grep -o 'Polygon Hermez ptau (54-party)'
Polygon Hermez ptau (54-party)
```

| Line | Found | Replacement |
|---|---|---|
| `docs/page.tsx:600` | Spec table row: `Trusted setup — Polygon Hermez ptau (54-party)` | Split into two rows so phase 2 cannot be read past: phase 1 as-is, phase 2 as `Demo setup: 1 contribution, no beacon`. |
| `docs/page.tsx:601` | `Cryptographic validity — Fully valid, on-chain verified` | `Proofs verify on-chain. Soundness is capped by the phase-2 demo setup above.` |
| `docs/page.tsx:722` | FAQ *"Is this production ready?"* answered with `The architecture is production-grade; the deployment is on Devnet for testing.` | Answer now opens with `No.` and states both phases. |

Patch: [`patches/aperture-dashboard-docs-page.patch`](./patches/aperture-dashboard-docs-page.patch).
The landing page was checked separately and is clean — it describes Circom,
Groth16 and timings without an assurance claim.

Applying the patch is not enough on its own: the site has to be redeployed for
the change to reach a reader. Confirm with the same `curl` above returning
nothing before treating this surface as done.
