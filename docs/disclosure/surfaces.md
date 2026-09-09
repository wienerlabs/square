# Surfaces: where the demo-setup disclosure has to appear

Issue [#3][i3] lists five surfaces. This file is the working record for all
five: what the audit found on each, what replaces it, and whether the change
has landed.

The wording all of it quotes from is [zk-setup-status.md](./zk-setup-status.md).
Change that file first, then propagate here.

Lines below that quote a claim verbatim carry the `ci-allow-phrase` marker, so
the CI guard lets the quotation through while still refusing the claim
anywhere else. An exception you can grep for is the point.

[i3]: https://github.com/wienerlabs/square/issues/3

| # | Surface | Audit result | Deliverable | Landed |
|---|---|---|---|---|
| 1 | Deck | No deck file exists in any repository reachable from this project | Slide copy, below | Copy ready |
| 2 | Three old repositories' READMEs | 6 claims in `aperture`; `aip-beta` and `covenant` clean | 3 applicable patches | Patches ready |
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

### aperture — 6 claims, all patched

| File | Line | Found | Why it is wrong |
|---|---|---|---|
| `README.md` | 14 | `- **Production ZK proofs** -- Circom + snarkjs Groth16 proofs...` <!-- ci-allow-phrase --> | The headline feature claim. Says production outright. |
| `README.md` | 49 | `...live transactions on Solana Devnet demonstrating the system in production.` | Devnet transactions are not production operation. |
| `README.md` | 308 | `Trusted setup:   shipped under circuits/payment-prover/build/payment_final.zkey` | Not false, but silent. A reader learns where the file is and nothing about what stands behind it. Silence here is the failure #3 is about. |
| `circuits/payment-prover/README.md` | 27 | `- **Phase 5:** production trusted-setup ceremony (Hermez ptau drop-in), ...` <!-- ci-allow-phrase --> | Phases 1–4 above it are each marked `(complete)`. Phase 5 carries no marker, so the list reads as nearly finished. |
| `circuits/payment-prover/README.md` | 103 | `## Production trusted setup` <!-- ci-allow-phrase --> | A section heading asserting the thing that has not happened. |
| `programs/verifier/src/groth16_vk.rs` | 18 | `Trusted setup basis: powersOfTau28_hez_final_14.ptau — the Polygon Hermez perpetual Powers of Tau ceremony with 54 contributors + beacon (phase 1).` <!-- ci-allow-phrase --> | **False.** The shipped key's alpha and beta match no published ceremony. See [zk-setup-status.md](./zk-setup-status.md#how-phase-1-is-identified). |

Patches: [`patches/aperture-README.patch`](./patches/aperture-README.patch),
[`patches/aperture-circuits-payment-prover-README.patch`](./patches/aperture-circuits-payment-prover-README.patch),
[`patches/aperture-groth16-vk-comment.patch`](./patches/aperture-groth16-vk-comment.patch).

The sixth finding is the one this disclosure got wrong itself. The first
version of this document repeated that `groth16_vk.rs` comment and called
phase 1 sound on the strength of it. Reading the artifact instead of the
comment says otherwise. The correction, and the check that produced it, are in
[zk-setup-status.md](./zk-setup-status.md).

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

Two failures in `.github/workflows/security.yml` predated this issue and were
found while working on it. Both have since been fixed on `main`, the second by
the reviewer:

1. The `forbidden strings` job had been failing on every run since the first
   commit, because its grep flagged `README.md:21` — the repository's own
   demo-setup disclaimer, which contained the literal phrase it was written to
   catch. The guard that was supposed to enforce #3 had never once passed.
2. The `secret scan` job failed with `[wienerlabs] is an organization. License
   key is required.` gitleaks-action requires a `GITLEAKS_LICENSE` secret for
   organisation repositories; `main` now runs the gitleaks CLI instead, which
   does not.

---

## 1. Deck

Insert as its own slide, placed immediately after whatever slide first shows a
proof or the word "zero-knowledge". It goes before the architecture slides, not
in an appendix.

> ### The trusted setup is a demo
>
> Groth16 needs a two-phase setup. Both halves of ours are development quality,
> and we would rather say so than have it found.
>
> - **Phase 1 — demo.** The powers of tau was generated locally, not taken from
>   a public ceremony. One machine held it.
> - **Phase 2 — demo.** One contribution. No beacon. One machine again.
>
> Either half alone lets whoever held that entropy forge a proof for any
> statement. Phase 1 is settled for keys built in the Square repository, which
> stand on the adopted Perpetual Powers of Tau contribution 80; the public
> multi-party **phase-2** ceremony is scheduled and has not been held. Until it
> completes and its verifying key is deployed, nothing here carries an assurance
> claim, and we are not asking anyone to put value behind it.
>
> `inspect-zkey-setup.mjs payment.zkey` → `phase 1 UNRECOGNISED, phase 2: 1, no beacon`

Speaker note for that slide:

> This is the slide people expect us to leave out. Both phases are development
> quality: the tau was made locally and phase 2 has a single contribution with
> no beacon. You do not have to take that from me — the tool reads it out of the
> key. Phase 1 we already closed, by adopting the public Perpetual Powers of Tau
> contribution 80 and checking its hash, so keys we build now stand on it. Issue
> 16 is the phase-2 ceremony and it is on the schedule. We will not describe this
> as production until it is done.

## 2. Three old repositories' READMEs

Apply the patches under [`patches/`](./patches/). Each was generated against a
clean clone and verified with `git apply --check`:

```bash
git clone https://github.com/wienerlabs/aperture.git
cd aperture
for p in ../square/docs/disclosure/patches/aperture-*.patch; do
  git apply --check "$p" && git apply "$p"
done
```

`aip-beta` and `covenant` need no change; see the audit above.

Note that these patches point at `circuits/scripts/inspect-zkey-setup.mjs` in
*this* repository. Aperture is being archived under [#5][i5]; the tool
deliberately lives here rather than being copied into a repository that is about
to freeze.

[i5]: https://github.com/wienerlabs/square/issues/5

## 3. Presentation materials

Any deck, one-pager, PDF or recorded talk that mentions proofs carries this
block. It is short enough to fit a footer and specific enough to be checkable:

> **Trusted setup: demo, both phases.** The powers of tau was generated locally
> rather than taken from a public ceremony, and phase 2 has one contribution
> with no beacon. Keys built in the Square repository stand on the adopted
> Perpetual Powers of Tau contribution 80 instead, so only the phase-2 ceremony
> is outstanding; it is scheduled, and until it completes, no assurance claim
> applies.
> Verify: `github.com/wienerlabs/square` → `docs/disclosure/zk-setup-status.md`

Rules for these materials:

- Never cite a contributor count for a ceremony this key was not built on. That
  specific move — naming a large public ceremony to make a locally generated
  setup sound rigorous — is the error this document exists to correct.
- Proving time, proof size and gas may be presented as measurements. They are
  not evidence of assurance and are not placed under a heading that implies it.
- No slide, caption or chart label uses the word "production" about the ZK
  layer while [#16][i16] is open.

[i16]: https://github.com/wienerlabs/square/issues/16

## 4. 1:1 notes and talk track

Raise it before the other side does. The moment to say it is the first time
proofs come up, not when someone asks how the setup was generated.

**If they ask nothing:**

> One thing I want to flag before you find it. Groth16 has a two-phase trusted
> setup, and both halves of ours are development quality. The powers of tau was
> generated on one machine rather than taken from a public ceremony, and phase 2
> has a single contribution with no beacon. Either one means whoever ran it
> could forge a proof. We are treating it as a demo. Phase 1 we have since
> closed by adopting an external tau with a published hash, the Perpetual Powers
> of Tau contribution 80, so keys we build now inherit it; the real **phase-2**
> ceremony is still ahead: public, multi-party, a beacon announced in advance,
> transcripts published. Until that lands we are not claiming assurance for any
> of it.

**If they ask "so are the proofs real?":**

> The proofs are real and they verify on-chain — that part is not marketing.
> What the demo setup costs us is unforgeability: a verifying proof means the
> prover knew a valid witness, *or* held setup entropy from either phase. The
> circuit is doing what it says. The setup behind it is not yet trustless.

**If they ask "how do you know phase 1 was local?":**

> The key tells you. In snarkjs, alpha and beta are copied straight out of the
> powers of tau and phase-2 contributions never touch them, so that pair
> fingerprints the tau. Ours matches no published ceremony; a key built on the
> public one carries values that show up in thousands of repositories. We only
> found this because a reviewer refused to take the source comment at face
> value, which is the right instinct and why the check is now a script.

**If they ask "when is the ceremony?":**

> The circuit has to freeze first — a change after the ceremony invalidates the
> zkey and we would run it twice. That is issue 14. Issue 15 is the invitation
> list, calendar, tau selection and beacon source, and it is already moving in
> parallel. Issue 16 is the ceremony itself. We would rather have you in it than
> take our word for it afterwards.

**Do not say:** that the setup is fine because some public ceremony had many
contributors, when this key was not built on it; that it is "good enough for a
demo" in a tone that implies it is nearly good enough for more; or that the
ceremony is "basically a formality".

## 5. a-perture.com

The site is the Next.js app in `aperture/dashboard/`, deployed from the
repository root `vercel.json`. The claims are on `/docs` and were confirmed
live during the audit:

```console
$ curl -sL https://a-perture.com/docs | grep -o 'production-grade'
production-grade
$ curl -sL https://a-perture.com/docs | grep -o 'Is this production ready'
Is this production ready
```

| Line | Found | Replacement |
|---|---|---|
| `docs/page.tsx:600` | Spec table row naming a 54-party public ceremony as the trusted setup <!-- ci-allow-phrase --> | Split into two rows, one per phase, each marked as a demo setup. |
| `docs/page.tsx:601` | `Cryptographic validity — Fully valid, on-chain verified` | `Proofs verify on-chain. Soundness is capped by the demo setup above.` |
| `docs/page.tsx:722` | FAQ *"Is this production ready?"* answered by calling the architecture production-grade <!-- ci-allow-phrase --> | Answer now opens with `No.` and states both phases. |

Patch: [`patches/aperture-dashboard-docs-page.patch`](./patches/aperture-dashboard-docs-page.patch).
The landing page was checked separately and is clean — it describes Circom,
Groth16 and timings without an assurance claim.

Applying the patch is not enough on its own: the site has to be redeployed for
the change to reach a reader. Confirm with the same `curl` above returning
nothing before treating this surface as done.
