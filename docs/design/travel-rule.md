# Travel Rule: the commitment goes on chain, the personal data never does

**Status:** design, decided in [#36][i36]. Depends on the compliance module in
[#27][i27] and, for the auditor path, the Merkle policy tree in [#45][i45].
Hands over from [#7][i7] (`did:aip` v2).

[i7]: https://github.com/wienerlabs/square/issues/7
[i16]: https://github.com/wienerlabs/square/issues/16
[i26]: https://github.com/wienerlabs/square/issues/26
[i27]: https://github.com/wienerlabs/square/issues/27
[i36]: https://github.com/wienerlabs/square/issues/36
[i45]: https://github.com/wienerlabs/square/issues/45

**This document is not legal advice.** It is an engineering design, and §7 is a
reasoned recommendation that counsel is required before any of it ships.

---

## The decision, in one paragraph

Square carries **no personal data** — not on chain, not encrypted on chain, not
in our database. When a release crosses the applicable threshold, the compliance
module requires a **32-byte commitment** to a Travel Rule payload that the
originator's obliged entity produced, and binds it to that specific release. The
payload itself travels off chain, between the obliged entities, on whatever rail
they already use. An auditor obtains the payload from the party that holds it and
uses the on-chain commitment to verify it is the payload that was bound to that
release, at that block, and has not been altered since. No new cryptography is
introduced, no viewing key is issued, and the circuit does not change.

## 1. The question that has to be answered first

The issue frames this as a tension between the Travel Rule and our privacy claim.
Before that can be addressed there is a prior question the framing skips:

> **Is anything in this system an obliged entity at all?**

The Travel Rule binds virtual asset service providers — entities that, as a
business and *on behalf of another person*, transfer or safekeep virtual assets.
Square is a set of non-custodial contracts. An institution funds `SquareJob`
escrow, an agent delivers, and the contract releases to the provider. Nobody
holds anybody's assets as a business.

That does **not** settle it. Whether the party deploying and operating these
contracts is conducting transfers on behalf of others is a legal determination
that turns on facts about control, fees, and the commercial relationship — not on
the architecture diagram. It is precisely the kind of question that has been
contested for non-custodial systems since FATF began addressing them.

So this design does not assume an answer. It is built so that **the obligation
can be discharged by whoever turns out to hold it**, and so that Square does not
accumulate personal data it would then be responsible for under either reading.

Three roles, named once and used throughout:

| Role | Who, in Square's terms |
|---|---|
| Originator | the institution funding the job — `SquareJob`'s `client` |
| Beneficiary | the agent operator receiving the release — the job's `provider`, or the buyer when the receivable was sold |
| Obliged entity | whoever is legally required to send or receive the payload — determined by counsel, not here |

## 2. Why the tension is smaller than it looks

The Travel Rule requires originator and beneficiary information to reach **the
counterparty's obliged entity**. It does not require that information to be
public, and it does not require it to be on a ledger.

Our claim is that this information does not go **on the chain**. Those two are
compatible. The apparent conflict comes from reading "the Travel Rule wants the
data transmitted" as "the Travel Rule wants the data published", which it does
not.

The real tension is different, and worth naming because it is the one that could
actually bite:

> Square is one of the few places that sees both sides of a settlement. That
> makes it the natural place for Travel Rule data to accumulate, and every
> integration will be tempted to route it through us because we are convenient.

The design below refuses that role deliberately. It is a constraint, not an
omission.

## 3. What goes on chain

Exactly one 32-byte value per release that requires it:

```
travelRuleCommitment = keccak256(
    abi.encode(
        TRAVEL_RULE_DOMAIN,   // a fixed domain separator, versioned
        chainId,
        jobId,
        payee,                 // the address that will actually be paid
        amount,                // net payout, USDC base units
        payloadHash,           // hash of the off-chain payload, as exchanged
        salt                   // 32 random bytes, held with the payload
    )
);
```

Four properties, each of which is the reason a field is present:

- **Bound to the release.** `jobId`, `payee` and `amount` mean a commitment
  cannot be replayed against a different payment, and a payment cannot be settled
  against somebody else's attestation. This is the same failure `contracts/README.md`
  already names for the compliance proof: an attestation not bound to a job is an
  attestation of somebody else's payment.
- **Bound to the chain.** `chainId` prevents a testnet attestation from
  satisfying a mainnet release.
- **Non-repudiable in time.** It is written in a block, so its existence at that
  height is established by consensus rather than by anyone's assertion.
- **Not a disclosure.** `salt` is a per-payload random value held alongside the
  payload. Without it, a commitment over low-entropy fields would be brute-
  forceable — names and account identifiers are guessable, and a commitment
  scheme over a guessable preimage discloses the preimage to anyone patient. This
  is the single easiest thing to get wrong here.

**It is emitted as an event, not stored.** Nothing on chain reads it again;
`services/indexer` already rebuilds state from events, and storage would cost gas
for a value that only humans and auditors consume.

## 4. What travels off chain, and how

The payload is whatever the applicable rule requires of the obliged entity —
originator and beneficiary identifiers and, in the stricter regimes, address or
identity-document detail. **Square does not define it, transport it, validate its
contents, or retain it.**

The interchange format is the one the industry already converged on for this data
(interVASP's IVMS101). We adopt it as the *hashing input format* only, so that
two parties who both follow it produce the same `payloadHash` from the same facts
— nothing more. Square never parses it.

The transport rail — which protocol carries the payload between obliged entities —
is **an open decision, deliberately left open here.** Several open protocols and
several commercial networks exist, and the right one is the one the institutions
already run; forcing a choice from inside the settlement layer would be the
wrong place to make it. What this design requires of any rail is only that both
sides can compute the same `payloadHash` over the same payload, and that both
retain the payload and the `salt` for their statutory retention period.

> **Open decision for the reviewer.** If this document should name specific
> protocols as candidates rather than describing the requirement abstractly, say
> so and they will be listed with the trade-offs. They are omitted for now
> because naming a rail reads as endorsing it.

## 5. Where it hooks, and why no interface changes

`docs/design/square-hook.md` already fixes the shape:

```
optParams = abi.encode(uint16 providerBps, bytes complianceProof)
```

and states that `complianceProof` is "opaque to the hook and is handed to the
compliance module unchanged; its inner layout … is #27's."

So the Travel Rule attestation rides inside that opaque field. Concretely, #27's
inner layout gains one optional member alongside the Groth16 proof and its eight
public signals:

```
complianceProof = abi.encode(
    Groth16Proof proof,
    uint256[8]   publicSignals,
    bytes32      travelRuleCommitment   // zero when not required
)
```

`SquareHook`, `SquareJob`, `ClaimMarket` and `IComplianceModule` are all
unchanged. That is the point of the seam being opaque.

The module's check, when the threshold is met:

1. `travelRuleCommitment != 0`, else revert.
2. Emit it, bound to `jobId`, `payee` and `amount`.

The module does **not** verify the payload — it cannot, and should not be able
to. It verifies that a commitment exists and is bound. Whether the payload behind
it is correct and complete is the obliged entity's duty, enforced by its
regulator, not by a contract.

### The threshold is public, and belongs in `PolicyRegistry`

The threshold at which the rule bites is a matter of public law, not of the
institution's business: it depends on the jurisdiction, and jurisdictions differ
sharply — the FATF baseline sits at a USD/EUR 1,000 figure, while the EU regime
for provider-to-provider crypto transfers is reported to carry no de minimis at
all (see §7 on the verification status of both claims). Publishing it discloses
nothing an institution would not disclose by naming its regulator.

So it is a public field beside `dailyLimit` in [`PolicyRegistry`][i26], not a
private rule inside the commitment, and not a new circuit rule.

**The circuit must not change for this.** Adding a seventh rule to
`payment.circom` changes the constraint system, invalidates the proving key, and
forces a new ceremony — and [#16][i16] has not run once yet. A design that costs
a ceremony to express a public integer is the wrong design.

## 6. Auditor access: no viewing key, and that is the recommendation

The issue asks whether a viewing-key-like mechanism is needed. **No — and
introducing one would make the position worse, not better.**

A viewing key implies a ciphertext for it to open. Putting encrypted personal
data on a public, immutable ledger creates three problems at once:

1. **Erasure becomes impossible.** Personal data on an immutable ledger cannot be
   deleted. Data-protection regimes that grant erasure rights and require bounded
   retention do not have an exception for "it was encrypted".
2. **The key becomes the whole security boundary, forever.** Ciphertext on a
   public chain is harvested once and kept indefinitely. Any future compromise of
   the key — or of the algorithm — retroactively discloses every payload ever
   written. This is the harvest-now-decrypt-later problem, applied to names and
   account numbers rather than to session traffic.
3. **It puts us in the middle.** Issuing viewing keys makes Square a participant
   in the disclosure, which is exactly the role §2 says to refuse.

The commitment scheme gives the auditor a strictly better position without any of
that. The auditor:

1. obtains the payload and `salt` from the obliged entity that holds them,
   through the channel it is already regulated to use;
2. recomputes `payloadHash` and then the commitment;
3. compares it against the value in the release's event.

A match proves the payload it was handed is the one bound to that release, at
that block height, unaltered. A mismatch is evidence of tampering. The auditor
learns everything it came for; the ledger held nothing.

The [Merkle policy tree][i45] serves the adjacent question — proving that a
policy contained a Travel Rule threshold rule, and what it was, without opening
the rest of the policy. That is why #45 lists this document as a dependent.

## 7. Two things that are not verified, and one that is

This section exists because the rest of the repository holds itself to producing
claims rather than repeating them, and this document could not fully meet that
standard.

**Verified, from the primary source.** Arc's privacy layer is
`Arc Privacy Sector` (APS), from the whitepaper of 8 June 2026 and
[Arc's own documentation][arcdocs], which states: "Privacy features are on the
roadmap and not yet available on Arc." It is **enclave-based, not
zero-knowledge**: a private EVM inside AWS Nitro Enclaves, with a master secret
key threshold-shared across validators. Its own §1.5 places it under
"Enclave-based approaches", explicitly distinct from the cryptography-based and
FHE families. Its stated non-goals include side-channel resistance: attacks "from
memory access patterns observable by the enclave host or through timing channels"
are "left to future work".

Its authenticated read path is `ethCallAuthorized`, which verifies the caller by
EIP-712 and sets `msg.sender` inside the private EVM. That is ordinary access
control on a view function — **not** a viewing key, and not delegable by handing
someone a secret.

[arcdocs]: https://docs.arc.io/arc/concepts/opt-in-privacy

**Not verified.** The regulatory figures in §5 — the FATF baseline threshold and
the EU's zero-threshold treatment of provider-to-provider crypto transfers — come
from secondary sources. The primary texts could not be retrieved: EUR-Lex
returned empty documents for Regulation (EU) 2023/1113 and the FATF publication
endpoint returned HTTP 403. **They are recorded here as unverified and must be
confirmed against the primary texts before anything is built on them.** Nothing
in the mechanism depends on the particular numbers — the threshold is a
configurable public field precisely so that being wrong about it is a
configuration change rather than a redesign — but the numbers must not be quoted
onward from this document as established.

**Not verified, and not verifiable by engineering at all.** Whether any party
here is an obliged entity (§1). That is §8.

## 8. Legal counsel is required — recommendation, with reasons

The acceptance criterion asks for a decision on whether legal advice is needed.
The recommendation is **yes, before implementation, not after**, for four
specific reasons rather than as a general disclaimer:

1. **The obliged-entity question (§1) determines whether any of this is required
   at all**, and it is a legal determination about control and commercial
   relationship. Building the mechanism without it risks either building
   something unnecessary or, far worse, believing an obligation has been
   discharged when it has not.
2. **Data-protection roles need to be assigned.** Even holding a `salt` and a
   hash, someone is a controller of something. The design's whole claim is that
   Square is not — that claim needs to be checked, not asserted by its authors.
3. **The rule is a patchwork and the numbers are unverified (§7).** Uneven
   implementation across jurisdictions means an originator and a beneficiary can
   be under materially different duties for one payment.
4. **Getting it wrong is not a bug.** Every other design decision in this
   repository can be corrected in a later release. This one carries regulatory
   consequences for the institutions using it.

What counsel should be asked, concretely:

- Is the operator of these contracts an obliged entity in the jurisdictions we
  intend to serve, and does the answer change if a fee is taken?
- Does a commitment plus an off-chain payload discharge the obligation, or must
  the obliged entity retain the transmission itself in a particular form?
- Who is the controller of the payload, the `salt`, and the on-chain commitment,
  and what is the retention period for each?
- How is a release to or from a self-hosted address treated, given that the
  beneficiary here is frequently an agent's own wallet?

## 9. When APS ships

APS changes what is *possible*, not what is *advisable*.

It would become possible to hold the payload in private contract state and to let
an auditor read it through `ethCallAuthorized` with ordinary `msg.sender` access
control. **The recommendation is not to.** The reasons in §6 survive: personal
data would then sit inside a system whose confidentiality rests on hardware
enclaves and a threshold-shared master key, and whose own whitepaper places
side-channel resistance outside its scope. Trading "personal data never touched
the ledger" for "personal data is on the ledger under a TEE" is a downgrade,
however good the TEE.

What APS is genuinely useful for here is a different thing: keeping the
**commitment and the threshold configuration** private, so that an observer
cannot see which releases crossed a Travel Rule threshold and therefore infer
payment sizes. That is a real leak in the design as written — the presence of a
non-zero commitment in an event is itself a signal that the release exceeded the
threshold — and it is the right thing to revisit when APS is available.

Recorded as a known limitation now rather than discovered later:

> **A non-zero Travel Rule commitment in a release event discloses that the
> release crossed the applicable threshold.** With a public threshold, that is a
> lower bound on the amount. `SquareJob` already exposes budgets on chain today
> (`JobRecord.budget`, `BudgetSet`), so this leaks nothing new in the current
> design; it becomes a genuine concern only in a future where amounts are
> confidential.

There is a cheaper fix than APS for that day, and it is worth recording now so it
is not reinvented: **always emit a commitment**, and below the threshold commit
to an empty payload under a fresh `salt`. The value is then indistinguishable
from a real one, the signal disappears, and the cost is one hash per release. It
is not worth doing while budgets are public, and it is the first thing to do if
they stop being.

## Acceptance criteria

- [x] Design document under `docs/`
- [x] A mechanism that does not contradict the privacy claim — §2, §3, §6: the
      chain holds one salted commitment, the personal data never reaches it, and
      the auditor is strictly better served than by a viewing key
- [x] A decision on whether legal advice is required — §8: yes, before
      implementation, with the four questions to put to counsel

Not in scope, and deliberately so: the transport rail (§4), the threshold values
themselves (§7), and implementation, which belongs with [#27][i27].
