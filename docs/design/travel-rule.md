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
[i90]: https://github.com/wienerlabs/square/issues/90

**This document is not legal advice.** It is an engineering design, and §7 is a
reasoned recommendation that counsel is required before any of it ships.

---

## The decision, in one paragraph

Square carries **no personal data** — not on chain, not encrypted on chain, not
in our database. When a release crosses the applicable threshold, the compliance
module expects a **signed attestation** from a registered obliged entity, bound
to that release, carrying a salted commitment to the Travel Rule payload. The
payload travels off chain between the obliged entities. An auditor obtains it
from whoever holds it and recomputes the commitment against the event.

Two things follow that are easy to get backwards, so they are stated here rather
than buried:

- **The value is signed.** A bare hash would not be a gate — `finalize` is
  permissionless and pays its caller, so unsigned bytes would pass and whoever
  passed them would be paid. Recovering an EIP-712 signature from an allowlisted
  attestor is what makes the record mean something (§3).
- **A missing attestation does not revert.** It makes the release *unattested* and
  emits why. Reverting would run the job to expiry, and [#90][i90] would hand the
  client a full refund — turning "the counterparty's rail was down" into "the
  provider worked for free", with the client as beneficiary (§5.2).

The circuit does not change, no interface changes, and no viewing key is issued.

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

An **attestation**, not a bare hash. The distinction is the whole of §3, because a
bare hash is not a gate: `KeeperEvaluator.finalize(uint256 jobId, bytes calldata
complianceProof)` is `external` with no access control, forwards its bytes
straight to the hook, and pays the caller the evaluator fee. Thirty-two random
bytes would pass, and whoever passed them would be paid for it.

So the value carries a signature from a party that can be held to it:

```solidity
struct TravelRuleAttestation {
    uint256 chainId;
    uint256 jobId;
    address payee;        // the address the kernel will actually pay
    uint256 amount;       // that address's slice, in USDC base units
    bytes32 payloadHash;  // keccak256 of the canonical payload, as exchanged
    bytes32 salt;         // 32 bytes from a CSPRNG, unique per attestation
    uint64  validUntil;   // seconds; the attestation expires
    bytes   signature;    // EIP-712, by a registered attestor
}
```

and what reaches the chain is the commitment plus the recovered attestor:

```solidity
travelRuleCommitment = keccak256(
    abi.encode(TRAVEL_RULE_DOMAIN, chainId, jobId, payee, amount, payloadHash, salt)
);
```

### Who signs, and why that is the load-bearing part

The signer is the **obliged entity for the originator side, or a delegate it
names**. The compliance module holds the set of addresses it will accept — an
allowlist its own owner maintains, which is the operator, not the institution
being regulated (§5.3).

That is what makes the value mean anything. Recovering an EIP-712 signature over
the struct above tells an auditor which entity asserted that a Travel Rule
payload existed for this release, and that entity cannot later say it did not.
An anonymous `finalize` caller can supply bytes; it cannot supply a signature
from an attestor it is not.

### Why each field is there

- **`jobId`, `payee`, `amount`** — bound to this release. An attestation not
  bound to a job is an attestation of somebody else's payment, which
  `contracts/README.md` already names as the failure for the compliance proof.
- **`chainId`** — a testnet attestation cannot satisfy a mainnet release.
- **`payloadHash`** — `keccak256` over the canonical serialisation of the payload
  as exchanged, byte for byte, so both sides compute the same value.
- **`salt`** — 32 bytes from a CSPRNG, fresh per attestation. Without it a
  commitment over names and account identifiers is brute-forceable: they are
  guessable, and a commitment over a guessable preimage discloses it to anyone
  patient. It is the single easiest thing to get wrong here.
- **`validUntil`** — an attestation that never expires is a bearer credential for
  a settlement that has not happened yet.

### `payee` and `amount` can change after the payload is exchanged

They are settled late, and the document has to say what that means rather than
leave an implementer to discover it.

`ClaimMarket.buy()` runs while a job is `Submitted` and flips `payeeOf` from the
provider to the buyer. `Arbitration` decides `providerBps` by vote, and the
module then sees `netPayout(jobId) * providerBps / 10_000`.

**Both changes invalidate the attestation, and that is correct.** A different
beneficiary is a different Travel Rule transfer; a different amount is a
different transfer. The obliged entities must exchange again and the attestor
must sign again. Anything else would bind a payload describing one payment to a
different one.

`amount` is **the payee's slice**, not the job's net payout. That is the number
the module receives and it is the right one: it is what reaches the beneficiary.
The client's share of a split is a refund, not a transfer to the beneficiary, and
fees are not transfers to the beneficiary either. An implementer who commits to
`netPayout` instead will produce a commitment that does not reconstruct, and §6's
auditor path is recomputation.

### Emitted, and amendable

Emitted by the compliance module, not stored: nothing on chain reads it again and
`services/indexer` already rebuilds state from events.

```solidity
event TravelRuleAttested(
    uint256 indexed jobId,
    address indexed attestor,
    address indexed payee,
    bytes32 commitment,
    uint256 amount,
    uint64  validUntil
);

event TravelRuleMissing(uint256 indexed jobId, address indexed payee, uint256 amount, uint8 reason);

event TravelRuleAmended(uint256 indexed jobId, bytes32 indexed supersedes, bytes32 commitment, string why);
```

The third exists because a record that cannot be corrected is not a record. A
release is written once and the job is then terminal, so without an amendment
path a wrong or superseded attestation would stand forever. `TravelRuleAmended`
is emitted by the module on the attestor's authority, references the commitment
it supersedes, and never deletes it — the original stays, which is the property
an auditor needs.

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

## 5. Where it hooks, and what happens when it fails

### 5.1 The seam does not change

`docs/design/square-hook.md` already fixes the shape:

```
optParams = abi.encode(uint16 providerBps, bytes complianceProof)
```

and states that `complianceProof` is "opaque to the hook and is handed to the
compliance module unchanged; its inner layout … is #27's."

So the attestation rides inside that opaque field as one member of #27's inner
layout:

```solidity
complianceProof = abi.encode(
    Groth16Proof proof,
    uint256[8]   publicSignals,
    bytes        travelRuleAttestation   // empty when none is offered
)
```

`SquareHook`, `SquareJob`, `ClaimMarket` and `IComplianceModule` are all
unchanged.

### 5.2 It does not revert, and that is a decision

**A missing or invalid attestation makes `checkRelease` return `false`. It does
not revert.**

This was the design's worst error in its first draft and it is worth stating why,
because reverting looks like the strict and therefore safe choice.

Read from the code: `SquareHook._checkRelease` stores the module's answer in
`_proofVerified`, and `afterAction` uses it for exactly one thing — whether to
write a **positive validation record** to ERC-8004. It does not gate the money.
Compliance in this architecture is a signal, which is the same thing
`contracts/README.md` says about `is_compliant`: the proof shows the checks ran,
not that they passed, and refusing is a separate decision.

A module that reverts fights that shape, and the consequence is not theoretical.
`complete` reverting is not innocent here: the job runs to expiry and
[#90][i90] returns the whole budget to the client. So "the counterparty's rail was
down" would resolve to "the provider worked for free" — and since §4 deliberately
leaves the rail open, a rail being down is an ordinary operational event, not an
exception. Worse, the client is the party who benefits, which turns a compliance
control into a griefing lever.

A contract cannot make a VASP transmit a payload. What it can do is record,
unforgeably and in a block, that one was or was not attested. So:

| Situation | `verified` | Emitted | Money |
|---|---|---|---|
| Attestation valid, above threshold | `true` | `TravelRuleAttested` | releases |
| Below threshold, none required | `true` | nothing | releases |
| Missing, expired, wrong signer, or bound to a different payee or amount | `false` | `TravelRuleMissing` with the reason | releases |

The remedy for the third row is regulatory and off chain, which is where an
obligation on a VASP belongs. What the chain contributes is that the failure is
on the record, permanently, next to the payment it belongs to.

### 5.3 The threshold does not live in `PolicyRegistry`

The first draft put it beside `dailyLimit`, and that was wrong for the reason the
same draft gave two paragraphs earlier: the threshold is a matter of public law,
not the institution's business. `PolicyRegistry` is keyed by `msg.sender` with no
access control — deliberately, so nobody can write another poster's row — which
means putting the threshold there **lets the obliged entity set the trigger of its
own obligation**. It also does not fit: [#26][i26]'s `Policy` has no such field,
no write path for one, and the contract is not upgradeable.

The threshold lives in the **compliance module** ([#27][i27]), set by the module's
owner. That owner is the operator's Safe, not the institution being regulated.
Per-jurisdiction values are a mapping in the module, not a field on a policy.

**A threshold of zero means every release requires an attestation.** Fail closed,
the same convention `PolicyRegistry` uses for `dailyLimit`, and cheap here
precisely because §5.2 does not revert: an unconfigured module marks releases
unattested and records why. It does not stop them and cannot strand a provider.

### 5.4 The module verifies the attestation, not the payload

It checks the signature, the attestor's membership, the expiry, and that
`payee` and `amount` match the release in front of it. It does **not** check that
the payload is correct or complete — it cannot, and should not be able to. That
is the obliged entity's duty, enforced by its regulator.

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

### Telling "checked and failed" from "nothing was checking"

An auditor has to be able to distinguish these, and on the hook alone it cannot.
`SquareHook._checkRelease` emits `ComplianceChecked(jobId, payee, amount,
verified)` on **every** completion, and `verified` starts `false` and stays
`false` when no module is installed — the module is optional, and
`setComplianceModule` is a single owner call with no zero check and no timelock.
The deployed hook returns the zero address from `complianceModule()` today, read
from chain, so every release so far carries `verified = false` for the plainest
of reasons.

Two things resolve it, and both are requirements of this design rather than
observations about it:

1. **The module emits its own events.** `TravelRuleAttested` and
   `TravelRuleMissing` come from the module, so their presence proves a module
   ran and their absence proves none did. `ComplianceChecked` alone cannot
   carry that.
2. **`ComplianceModuleUpdated` is the timeline.** Its history says which module
   was installed at which block, so an auditor can establish for any release
   whether one existed, which one, and since when.

An auditor reading a release with `verified = false` and no `TravelRuleMissing`
beside it is looking at a release nothing checked — and that is a finding about
the operator, not about the payment.

## 6b. The binding parameters

Two implementations that agree on everything above and disagree on any of these
will not interoperate, so they are fixed here rather than left to be inferred
from prose. Nothing in this section is a preference; each line is a value an
implementer would otherwise have to guess.

| | Value |
|---|---|
| `TRAVEL_RULE_DOMAIN` | `keccak256("square.travelrule.v1")` |
| Versioning | The version lives in the domain string. A change of payload semantics or of the attestation struct means `v2` and a new domain, never a reinterpretation of `v1`. |
| EIP-712 domain | `name: "SquareTravelRule"`, `version: "1"`, `chainId`, `verifyingContract`: the compliance module |
| `payloadHash` | `keccak256` over the canonical serialisation of the payload exactly as exchanged, byte for byte. Both sides hash what crossed the wire, not their own re-rendering of it. |
| `salt` | 32 bytes from a CSPRNG, fresh per attestation, never derived from the payload or reused across releases. Retained with the payload; without it the commitment cannot be recomputed. |
| Commitment | `keccak256(abi.encode(TRAVEL_RULE_DOMAIN, chainId, jobId, payee, amount, payloadHash, salt))` |
| Who computes it | The attestor — the originator's obliged entity or its named delegate. Not Square, not the keeper, not the agent. |
| How it reaches the chain | Inside `complianceProof`, through `KeeperEvaluator.finalize`. That path is permissionless by design, which is exactly why the value is signed: the carrier is untrusted and does not need to be trusted. |
| Attestor set | An allowlist held by the compliance module, maintained by the module's owner. Membership changes are events, so an auditor can establish who was trusted at a given block. |
| Expiry | `validUntil`, seconds. An attestation with no expiry is a bearer credential for a settlement that has not happened. |
| Events | `TravelRuleAttested`, `TravelRuleMissing`, `TravelRuleAmended`, signatures in §3 |

The `reason` byte on `TravelRuleMissing` distinguishes the ways it can fail, so
the record says which: `1` none offered, `2` malformed, `3` signature invalid,
`4` attestor not registered, `5` expired, `6` bound to a different payee or
amount.

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
in the mechanism depends on the particular numbers — the threshold is an
owner-set value in the compliance module (§5.3) precisely so that being wrong
about it is a configuration change rather than a redesign — but the numbers must
not be quoted onward from this document as established.

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
**attestation events and the threshold configuration** private, so that an
observer cannot see which releases crossed a threshold and therefore infer
payment sizes.

Recorded as a known limitation now rather than discovered later:

> **The events leak whether a release crossed the threshold.** A
> `TravelRuleAttested` says it did; the silence where one would be says it did
> not; and `TravelRuleMissing` says it did and nobody attested. With a public
> threshold each is a bound on the amount. `SquareJob` already exposes budgets on
> chain (`JobRecord.budget`, `BudgetSet`), so this leaks nothing new today; it
> becomes a genuine concern only in a future where amounts are confidential.
>
> The `attestor` topic is the second half of it: it names which obliged entity
> stood behind a payment, and over time the set of an institution's
> counterparties is inferable from the chain alone.

There is a cheaper fix than APS for the first half, worth recording now so it is
not reinvented: **emit on every release**, and below the threshold attest to an
empty payload under a fresh `salt`. The event is then indistinguishable from a
real one, the signal disappears, and the cost is one signature and one hash per
release. It is not worth doing while budgets are public, and it is the first
thing to do if they stop being. It does not help the `attestor` topic, which
needs APS or an indirection this design does not have.

## Acceptance criteria

- [x] Design document under `docs/`
- [x] A mechanism that does not contradict the privacy claim — §2, §3, §6: one
      salted commitment on chain under a signature, the personal data never
      reaches it, and the auditor strictly better served than by a viewing key
- [x] A decision on whether legal advice is required — §8: yes, before
      implementation, with the four questions to put to counsel

Not in scope, and deliberately so: the transport rail (§4), the threshold values
themselves (§7), and implementation, which belongs with [#27][i27].

## What [#27][i27] inherits

Written down so the implementer is not deciding it a second time:

| | |
|---|---|
| The attestor allowlist | storage, an owner-only setter, and an event on every membership change |
| The threshold | a per-jurisdiction mapping in the module, owner-set, zero meaning "attest everything" (§5.3) |
| `checkRelease` | returns `false` on a failed or absent attestation. It must not revert (§5.2) |
| The three events | signatures in §3, `reason` codes in §6b |
| The amendment path | `TravelRuleAmended`, on the attestor's authority, never deleting what it supersedes |
| Recomputation | `payee` and `amount` must be compared against the release in front of the module, not taken from the attestation (§3) |

And the one thing it must **not** inherit: a seventh circuit rule. The threshold
comparison happens in the module against public signal 3, not in
`payment.circom`, because a new rule there invalidates the proving key and costs
a ceremony that has not run once ([#16][i16]).
