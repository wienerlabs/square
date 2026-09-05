# The `did:aip` DID Method Specification v2.0

**Status:** Draft
**Supersedes:** `did:aip` v1.0 (Solana), registered in the W3C DID Extensions registry via
[w3c/did-extensions#704](https://github.com/w3c/did-extensions/pull/704) (merged 2026-05-31)
**Editors:** Wiener Labs

---

## Abstract

`did:aip` is a DID method for autonomous software agents. Version 1.0 anchored agent
identity in a purpose-built Solana program. Version 2.0 replaces that anchor with
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registries on EVM chains.

The method no longer defines its own registry. It defines how to name an ERC-8004 agent as
a DID, and how to derive a DID Core 1.0 conformant DID Document from on-chain state plus
the agent's registration file. Anything ERC-8004 already specifies is referenced, not
restated.

v1 identifiers remain resolvable. §9 defines the discrimination rule and the migration
path.

---

## 1. Motivation

### 1.1 Why change the anchor

v1 shipped its own Solana program because no neutral agent registry existed. ERC-8004 is
now that registry, it is deployed as a per-chain singleton, and it is where agent identity
is accumulating. A DID method that competes with it fragments the namespace it is supposed
to unify.

The useful thing v1 had was not the program. It was the mapping from an on-chain agent
record to a W3C DID Document — an interoperability layer that lets a wallet, a resolver, or
an MCP client consume agent identity without knowing anything about the chain underneath.
v2 keeps that and drops the rest.

### 1.2 Relationship to ERC-8004

ERC-8004 already defines a global agent identifier:

```
agentRegistry = {namespace}:{chainId}:{identityRegistry}     e.g. eip155:1:0x742…
agentId       = the ERC-721 tokenId
```

`did:aip` v2 is a **lossless wrapper** around that pair. Every v2 DID maps to exactly one
`(agentRegistry, agentId)` and back. The method adds no identity of its own.

ERC-8004's registration file already reserves a `DID` entry in `services[]`. An agent that
publishes its `did:aip` there is making the round trip verifiable in both directions, which
§8.3 requires for cross-chain claims.

### 1.3 Design goals

- **No new trust.** Resolution reads ERC-8004 and the registration file. Nothing else.
- **Reversible.** DID ⇄ `(agentRegistry, agentId)` is a total, injective mapping.
- **Chain-agnostic within EVM.** The chain is a parameter, not a fork of the method.
- **v1 keeps working.** No silent breakage; §9.

---

## 2. Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, MAY are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

| Term | Meaning |
|---|---|
| **Identity Registry** | An ERC-8004 `IdentityRegistry` contract (ERC-721 + URIStorage) |
| **Agent** | The ERC-721 token in an Identity Registry; `agentId` is its `tokenId` |
| **Owner** | `ownerOf(agentId)`. Controls transfer and the registration file. |
| **Agent Wallet** | `getAgentWallet(agentId)`. Where the agent is paid. May differ from Owner. |
| **Agent URI** | `tokenURI(agentId)`, called `agentURI` in ERC-8004 |
| **Registration File** | The JSON document the Agent URI resolves to |

---

## 3. Method Syntax

### 3.1 Method name

The method name is `aip`. Unchanged from v1.

### 3.2 Method-specific identifier (Normative)

```abnf
did-aip-v2   = "did:aip:" namespace ":" chain-id ":" registry ":" agent-id

namespace    = "eip155"                    ; only EVM chains are defined in v2
chain-id     = 1*DIGIT                      ; EIP-155 chain id, no leading zeros
registry     = "0x" 40HEXDIG                ; Identity Registry address
agent-id     = 1*DIGIT                      ; ERC-721 tokenId, no leading zeros

HEXDIG       = DIGIT / "a" / "b" / "c" / "d" / "e" / "f"
```

The concatenation `namespace ":" chain-id ":" registry` is exactly ERC-8004's
`agentRegistry` string.

A conforming implementation **MUST** reject a DID where:

- `namespace` is not `eip155`;
- `chain-id` or `agent-id` has a leading zero, or is not a decimal integer;
- `registry` is not exactly `0x` followed by 40 hexadecimal digits;
- the method-specific identifier does not have exactly four colon-separated segments.

**Address case.** `registry` **MUST** be lowercase in the DID string. EIP-55 mixed-case
checksums are a display convention; permitting them here would make two byte-different
strings denote the same agent and break DID equality, which DID Core defines as string
equality. A resolver **MUST** reject a mixed-case `registry` rather than normalise it —
silent normalisation would let two DIDs resolve identically while comparing unequal, and
callers do compare DIDs as strings.

### 3.3 Examples

```
did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2
did:aip:eip155:1:0x8004a818bfb912233c491871b3d84c89a494bd9e:22
```

The first is a live agent on Arc Testnet at the time of writing.

---

## 4. DID Document Construction

### 4.1 Required properties (Normative)

| Property | Value |
|---|---|
| `@context` | `["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/secp256k1recovery-2020/v2"]` |
| `id` | The DID, byte-identical to the input after §3.2 validation |
| `controller` | `did:pkh:eip155:{chainId}:{owner}` — see §4.3 |
| `verificationMethod` | §4.2 |
| `authentication` | `[ "#owner" ]` |
| `capabilityInvocation` | `[ "#owner" ]` |
| `assertionMethod` | `[ "#owner" ]`, plus `"#agent-wallet"` when §4.4 applies |
| `service` | §4.5 |

### 4.2 `verificationMethod`

The Owner is known to the resolver only as an address; the public key is not on-chain
until the account has signed something. The method therefore identifies keys by account,
using `EcdsaSecp256k1RecoveryMethod2020` with `blockchainAccountId` in
[CAIP-10](https://chainagnostic.org/CAIPs/caip-10) form.

```json
{
  "id": "{did}#owner",
  "type": "EcdsaSecp256k1RecoveryMethod2020",
  "controller": "{did}",
  "blockchainAccountId": "eip155:{chainId}:{ownerOf(agentId)}"
}
```

`blockchainAccountId` **MUST** carry the EIP-55 mixed-case checksum form of the address,
because CAIP-10 specifies it. This is deliberately the opposite of §3.2: the DID string is
an identifier and must be canonical; `blockchainAccountId` is a value and follows its own
specification. Implementers should expect the same address to appear lowercase in `id` and
checksummed in `blockchainAccountId`, and **MUST NOT** "fix" either.

### 4.3 `controller`

`controller` is the Owner expressed as a `did:pkh` DID. Using `did:pkh` rather than the
raw address keeps `controller` a DID, as DID Core requires, without inventing a second
identifier for an account that already has a standard one.

**Ownership is transferable.** ERC-8004 identities are ERC-721 tokens. A transfer changes
`controller` with no change to the DID. This is a deliberate departure from v1, where the
owner was a PDA seed and ownership transfer was impossible (v1 §7.2). Consumers that cached
a DID Document **MUST NOT** assume `controller` is stable; see §10.2.

### 4.4 Agent Wallet

If `getAgentWallet(agentId)` returns a non-zero address, the resolver **MUST** add:

```json
{
  "id": "{did}#agent-wallet",
  "type": "EcdsaSecp256k1RecoveryMethod2020",
  "controller": "{did}",
  "blockchainAccountId": "eip155:{chainId}:{agentWallet}"
}
```

and reference it from `assertionMethod`.

It is referenced from `assertionMethod` and **not** from `authentication` or
`capabilityInvocation`. ERC-8004 requires an EIP-712 or ERC-1271 signature to set the Agent
Wallet, so control is proven — but what is proven is control of a payment destination, not
authority over the identity. Only the Owner can transfer the agent or change its
registration file, and `authentication` should reflect that. A verifier that treats a
payment address as an authentication key would accept the agent's hot wallet where it
should require the owner.

ERC-8004 clears the Agent Wallet automatically on transfer. A resolver **MUST NOT** cache
it across a `Transfer` event; see §10.2.

### 4.5 `service`

Service entries are derived from the `services[]` array of the Registration File (§5).

For each entry, the resolver emits:

```json
{
  "id": "{did}#{name-slug}",
  "type": "{name}",
  "serviceEndpoint": "{endpoint}"
}
```

`name-slug` is `name` lowercased with any character outside `[a-z0-9]` replaced by `-`.
Where two entries slug identically, the resolver **MUST** suffix `-2`, `-3`, … in array
order, so that `service` ids stay unique as DID Core requires.

A `DID` entry in `services[]` whose endpoint is the DID being resolved is a self-reference.
It **MUST** be omitted from `service` — it carries no information and a naive consumer
following it would loop.

### 4.6 Example

For `did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2`:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
  ],
  "id": "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2",
  "controller": "did:pkh:eip155:5042002:0x7954350d124Ff904F0D4D89CCEB4499C852C4628",
  "verificationMethod": [
    {
      "id": "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2#owner",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2",
      "blockchainAccountId": "eip155:5042002:0x7954350d124Ff904F0D4D89CCEB4499C852C4628"
    }
  ],
  "authentication": ["did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2#owner"],
  "capabilityInvocation": ["did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2#owner"],
  "assertionMethod": ["did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2#owner"],
  "service": []
}
```

`service` is empty here because this agent's Registration File declares no `services[]`.

---

## 5. The Registration File

ERC-8004 defines the Registration File; this method does not redefine it. Two rules matter
for resolution:

1. **The Agent URI may be empty.** `tokenURI` returning `""` is a registration made with
   the no-argument `register()`. This is not an error: the agent exists and is owned. The
   resolver **MUST** produce a valid DID Document with an empty `service` array. *(This is
   the state of `agentId` 1 on Arc Testnet at the time of writing, so it is the common case
   and not a corner case.)*

2. **The Registration File is not trusted input.** It is a document the Owner controls, at
   a URI the Owner controls. Everything derived from it is a claim by the Owner, not a fact
   established by the chain. §10.1 and §10.3 are consequences of this.

A resolver **MUST NOT** fail resolution because the Agent URI is unreachable, returns
malformed JSON, or fails schema validation. It **MUST** return the DID Document derived
from on-chain state alone and report the failure in `didResolutionMetadata.warnings`. On-
chain state is authoritative for identity; the Registration File only enriches it, and an
identity that disappears because a gateway is down is not censorship-resistant.

---

## 6. Resolution (Normative)

```
resolve(did):
  1. Parse per §3.2. On failure → error "invalidDid".
  2. If the identifier has two segments → v1; go to §9.2.
  3. Select an RPC endpoint for chain-id. If none is configured → error "unsupportedChain".
  4. owner ← ownerOf(agentId) on registry.
     If it reverts → error "notFound".              (unminted or burned)
  5. agentWallet ← getAgentWallet(agentId), if the registry exposes it.
     Treat a revert as "not set", not as an error: it is OPTIONAL in ERC-8004.
  6. agentURI ← tokenURI(agentId).
  7. If agentURI is non-empty, dereference it and parse JSON.
     On any failure, record a warning and continue with an empty registration file.
  8. Assemble the DID Document per §4.
  9. Return it with the metadata of §6.1.
```

Steps 4–6 are three `eth_call`s against a single contract and are the only mandatory
network operations. Step 7 is the only step that leaves the chain.

### 6.1 Resolution metadata

| Field | Value |
|---|---|
| `didResolutionMetadata.contentType` | `application/did+ld+json` |
| `didResolutionMetadata.warnings` | Non-fatal problems, e.g. an unreachable Agent URI |
| `didDocumentMetadata.versionId` | The block number the state was read at |
| `didDocumentMetadata.deactivated` | `true` per §7 |
| `didDocumentMetadata.agentRegistry` | The ERC-8004 `agentRegistry` string |

`versionId` is the block number, not a timestamp: on a chain with sub-second deterministic
finality, the block number is the only value that identifies the state exactly.

**A resolver MUST NOT throw.** Failures are reported in `didResolutionMetadata.error`, per
DID Resolution. This is inherited from the v1 resolver, where it was load-bearing: callers
embed resolution in agent-to-agent dispatch and an exception there takes down the caller,
not just the lookup.

---

## 7. Deactivation

An agent is deactivated when either holds:

- `ownerOf(agentId)` reverts after having previously succeeded — the token was burned; or
- the Registration File sets `"active": false`.

The first is on-chain and authoritative. The second is a claim by the Owner and can be
reversed by editing a JSON file. A resolver **MUST** set `didDocumentMetadata.deactivated`
in both cases and **MUST** distinguish them in `didDocumentMetadata`, because a consumer
deciding whether to pay an agent needs to know whether the identity is gone or merely
parked.

There is no third state. ERC-8004 has no revocation registry and this method does not add
one.

---

## 8. Cross-chain Registrations

ERC-8004's Registration File may list other registrations:

```json
"registrations": [
  { "agentId": 22, "agentRegistry": "eip155:1:0x8004…" }
]
```

Each entry maps to a `did:aip` v2 DID by §3.2.

**These are claims, not facts.** Anyone may write any `agentRegistry` into their own
Registration File. A resolver **MUST NOT** treat a cross-registration as equivalent to the
DID being resolved unless the round trip verifies: resolve the counterpart DID and confirm
that *its* Registration File lists the original `(agentId, agentRegistry)` back.

Unverified, a cross-registration is an impersonation primitive: an agent on a cheap chain
can claim to be a reputable agent on Mainnet, and any consumer that merges reputation
across the claimed pair inherits a reputation it did not earn. Resolvers **SHOULD** expose
verified and unverified cross-registrations as distinct fields rather than merging them.

---

## 9. Version Discrimination and Migration

### 9.1 Discrimination (Normative)

Count the colon-separated segments of the method-specific identifier:

| Segments | Version | Shape |
|---|---|---|
| 2 | v1 | `{base58 Ed25519 pubkey}:{agent-id}` |
| 4 | v2 | `{namespace}:{chain-id}:{registry}:{agent-id}` |
| other | — | error `invalidDid` |

The counts cannot collide: a v1 owner segment is a base58 encoding of exactly 32 bytes and
is 32–44 characters, and v2's first segment is the fixed token `eip155`. Segment count
alone is sufficient, and a resolver **MUST** use it rather than pattern-matching the first
segment, which is the fragile version of the same test.

### 9.2 v1 resolution

A resolver **MAY** support v1. One that does **MUST** resolve it per the v1 specification
against Solana, and **MUST** set `didDocumentMetadata.deprecated = true`.

A resolver that does not support v1 **MUST** return `didResolutionMetadata.error =
"unsupportedVersion"` — not `invalidDid`. A v1 DID is well-formed; the resolver merely does
not speak it, and callers need to tell those apart to decide whether to try another
resolver.

### 9.3 Migration

There is no on-chain migration. The two anchors are different chains with different key
types; a v1 Ed25519 owner cannot control a v2 ERC-721 token.

An operator migrating an agent SHOULD:

1. Register the agent in an ERC-8004 Identity Registry, obtaining a v2 DID.
2. Publish the v2 DID in the v1 agent card, so that consumers holding the v1 DID discover
   the successor.
3. Publish the v1 DID in the v2 Registration File's `services[]` as a `DID` entry, so the
   link is visible from both sides.
4. Keep the v1 record resolvable, marked deactivated per v1 §5.4, rather than closing it —
   a closed v1 record resolves to `notFound`, which is indistinguishable from "never
   existed" and strands anyone holding the old identifier.

This is a documented succession, not a cryptographic one. Nothing proves the same operator
controls both, and neither DID inherits the other's reputation. §8's round-trip rule does
not apply across versions, because the v1 registry has no `registrations[]` field.

---

## 10. Security Considerations

### 10.1 The registry address is part of the identifier

Anyone can deploy a contract with the ERC-8004 interface. The `registry` segment is what
makes a v2 DID meaningful: two agents with the same `agentId` in different registries are
different agents, and a registry the consumer does not recognise carries no weight.

Consumers **SHOULD** maintain an allowlist of registry addresses they honour, and
**MUST NOT** treat "resolves successfully" as "is trustworthy". Resolution proves the token
exists in the named contract, nothing more.

### 10.2 Ownership and wallet mutability

Two properties change under the DID without the DID changing:

- **Owner**, via ERC-721 transfer. `controller`, `#owner` and the whole authorisation set
  change with it.
- **Agent Wallet**, via `setAgentWallet`, and it is cleared automatically on transfer.

A consumer that caches a DID Document is caching a snapshot. Anything that authorises a
payment or accepts a signature **MUST** re-resolve, or verify against the block number in
`didDocumentMetadata.versionId`. Caching by TTL is not sound here: a transfer is
instantaneous and gives no warning.

This is a real regression from v1, where ownership transfer was impossible by construction,
and it is the price of using a transferable token as the anchor. It should be stated
plainly rather than left for integrators to discover.

### 10.3 Registration File integrity

The Agent URI may be `https://`, in which case the content can change without any on-chain
trace, or `ipfs://`, in which case the CID commits to the content but the Owner can still
repoint `agentURI`. Neither gives the consumer a stable document.

Service endpoints therefore carry exactly the trust of the Owner. A consumer **MUST NOT**
infer that an endpoint listed in the Registration File is operated by, or authorised to
speak for, anyone other than the Owner. Endpoint authenticity requires a separate
challenge, as in v1 §7.5.

Resolvers **SHOULD** prefer content-addressed schemes and **SHOULD** report the scheme in
resolution metadata, so a consumer can apply its own policy.

### 10.4 Chain identifier confusion

`chain-id` selects which chain the resolver reads. A resolver configured with the wrong RPC
for a chain id will return a DID Document for a different agent under the correct-looking
DID, with no error.

A resolver **MUST** verify that the RPC endpoint reports a matching `eth_chainId` before
using it, and **MUST** re-verify after any endpoint failover.

### 10.5 What ERC-8004 does not give

There is no key rotation for the Owner: rotation means transferring the token, which is
ownership change, not rotation. There is no revocation registry, no proof of liveness, and
no binding between the agent and the software it runs. This method inherits all of those
gaps and does not paper over them.

---

## 11. Privacy Considerations

Everything on-chain is public: the Owner address, the Agent Wallet, the Agent URI, and the
full transfer history of the token. Resolving a DID is a public read; publishing a DID
links every associated address permanently and irreversibly.

The Agent Wallet is a linkability hazard specifically. It is the payment destination, so it
appears in the agent's transaction graph; publishing it in the DID Document ties the
identity to that graph for anyone who looks. Operators wanting separation **SHOULD** use a
wallet dedicated to the agent, and note that transfers clear it, which is a privacy benefit
as well as an operational hazard (§10.2).

Dereferencing an Agent URI reveals the resolver's interest to the URI's host. Resolvers
handling third-party DIDs **SHOULD** fetch through a cache or a gateway they operate rather
than letting each lookup reach the Owner's server directly.

---

## 12. Conformance to DID Core 1.0

| Requirement | Status |
|---|---|
| Method name is a lowercase ASCII string | ✅ `aip` |
| Method-specific identifier syntax is defined in ABNF | ✅ §3.2 |
| DID Documents are DID Core 1.0 conformant | ✅ §4 |
| `id` matches the resolved DID | ✅ §4.1 |
| Verification method types are registered | ✅ `EcdsaSecp256k1RecoveryMethod2020` |
| CRUD operations are specified | ✅ ERC-8004 (create/update), §7 (deactivate) |
| Resolution is specified | ✅ §6 |
| Security considerations | ✅ §10 |
| Privacy considerations | ✅ §11 |

The method defines no `did:aip`-specific properties and no new JSON-LD terms.

---

## 13. Updating the W3C Registration

[w3c/did-extensions#704](https://github.com/w3c/did-extensions/pull/704) was **merged on
2026-05-31** and added `methods/aip.json`. A merged PR cannot be amended; the update is a
new pull request against `w3c/did-extensions`.

The registry entry itself is small — name, contact, specification URL — so the substantive
change is that the specification URL points at this document. The v1 specification stays
published at its current URL, because §9.2 lets a resolver support v1 and a resolver author
needs to be able to read what they are implementing.

Checklist for the new PR:

- [ ] `methods/aip.json`: specification URL → this document
- [ ] Keep the v1 URL reachable and linked from §9
- [ ] Note in the PR description that this is a substrate change (Solana → ERC-8004), not
      a syntax clarification, so reviewers do not read it as editorial
- [ ] Cross-reference ERC-8004 as the underlying registry

---

## 14. References

### 14.1 Normative

- [DID Core 1.0](https://www.w3.org/TR/did-core/)
- [DID Resolution](https://w3c-ccg.github.io/did-resolution/)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-721](https://eips.ethereum.org/EIPS/eip-721), [ERC-721 URIStorage](https://eips.ethereum.org/EIPS/eip-721)
- [EIP-155](https://eips.ethereum.org/EIPS/eip-155), [EIP-55](https://eips.ethereum.org/EIPS/eip-55)
- [EIP-712](https://eips.ethereum.org/EIPS/eip-712), [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271)
- [CAIP-10](https://chainagnostic.org/CAIPs/caip-10)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)

### 14.2 Informative

- `did:aip` v1.0 — the Solana-anchored predecessor
- [`did:pkh`](https://github.com/w3c-ccg/did-pkh)
- [`did:ethr`](https://github.com/decentralized-identity/ethr-did-resolver) — prior art for
  address-based EVM verification methods

---

## Appendix A — Test Vectors (Informative)

A machine-readable form of this appendix is in [`test-vectors.json`](./test-vectors.json).
The resolver implementation consumes it directly, so the two cannot drift.

Read from Arc Testnet (`eip155:5042002`), Identity Registry
`0x8004a818bfb912233c491871b3d84c89a494bd9e`. Values were live at the time of writing;
`ownerOf` and `tokenURI` are mutable and these are a snapshot, not fixtures.

### A.1 Parsing

| DID | namespace | chainId | registry | agentId |
|---|---|---|---|---|
| `did:aip:eip155:5042002:0x8004…bd9e:2` | `eip155` | `5042002` | `0x8004…bd9e` | `2` |

### A.2 On-chain reads for `agentId` 2

| Call | Result |
|---|---|
| `ownerOf(2)` | `0x7954350d124ff904f0d4d89cceb4499c852c4628` |
| `getAgentWallet(2)` | `0x7954350d124ff904f0d4d89cceb4499c852c4628` |
| `tokenURI(2)` | `ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei` |

`getAgentWallet` equals `ownerOf` because it defaults to the Owner until `setAgentWallet`
is called.

### A.3 Empty Agent URI

`agentId` 1 has `tokenURI(1) == ""`. Per §5.1 this resolves successfully to a DID Document
with an empty `service` array. Any resolver that errors on this case is non-conforming, and
this vector exists because it is the case implementations are most likely to get wrong.

### A.4 Rejected inputs

| Input | Reason |
|---|---|
| `did:aip:eip155:5042002:0x8004A818BFB912233C491871B3D84C89A494BD9E:2` | mixed-case registry (§3.2) |
| `did:aip:eip155:05042002:0x8004…bd9e:2` | leading zero in chain-id |
| `did:aip:solana:mainnet:0x…:2` | namespace is not `eip155` |
| `did:aip:eip155:5042002:0x8004…bd9e` | three segments |
| `did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:scribe` | two segments → v1 (§9.1), not an error |
