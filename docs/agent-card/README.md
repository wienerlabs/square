# The agent card

The document an ERC-8004 `agentURI` resolves to.

- [`schema.json`](./schema.json) — JSON Schema 2020-12
- [`examples/`](./examples) — minimal, typical, full

## Why this document exists

The Solana registry stored a rich record **on-chain**: name, endpoint, capabilities, type,
price and version, in a 1366-byte account. ERC-8004 stores one `agentURI` and nothing else.

The schema did not disappear; it moved. Everything the account used to hold now lives in
the JSON that URI points at, and the trade is explicit: the data is no longer readable from
the chain in a single call, and it is no longer as tamper-evident. §"What this costs" below
says what that means in practice.

## Field-by-field, from the old account

The account was 8 bytes of discriminator plus 1358 of payload:

| `AgentRecord` field | Bytes | Where it goes now |
|---|---|---|
| `owner` | 32 | On-chain: `ownerOf(agentId)`. Not in the card. |
| `agent_id` (slug) | 36 | `x-aip.slug` — **demoted to a label**, see below |
| `did` | 104 | `services[]` entry, `name: "DID"`. Derivable from the registry and tokenId, so it is a convenience, not a source of truth. |
| `name` | 68 | `name` |
| `endpoint` | 204 | `services[]` entry, `name: "A2A"` |
| `wallet_address` | 32 | On-chain: `agentWallet`, set via `setAgentWallet`. Not in the card. |
| `agent_type` | 1 | `x-aip.agentType` |
| `capabilities` (max 8 × 104) | 836 | `x-aip.capabilities`, now with per-capability pricing and no cap at 8 |
| `price_per_task` | 8 | Folded into `x-aip.capabilities[].pricing` |
| `version` | 20 | `x-aip.agentVersion` |
| `registered_at`, `updated_at` | 16 | On-chain: `Transfer` and `MetadataSet` events. Not in the card. |
| `bump` | 1 | A PDA artifact. Gone. |

**`agent_id` is the one real loss.** It was an identifier: PDA seeds were
`["agent", owner, agent_id]`, so `(owner, slug)` addressed the record and the slug was
unique per owner. ERC-8004 identifies agents by an incrementing `tokenId`, and nothing
enforces slug uniqueness anywhere. It survives as `x-aip.slug` for display and search only.
The schema says so and a reader **MUST NOT** key anything on it — two agents may carry the
same slug, and a slug can change between reads.

**Two things got better.** Capabilities are no longer capped at 8, a limit that existed
purely to keep the account a fixed size; and each capability carries its own price, where
the account had a single `price_per_task` for the whole agent. The off-chain marketplace
already worked this way, so the card closes a gap between the two layers rather than
inventing one.

## What the extension is, and why it is namespaced

ERC-8004 fixes `type`, `name`, `description`, `image`, `services[]`, `x402Support`,
`active`, `registrations[]` and `supportedTrust[]`. Everything AIP needs beyond that goes
under a single `x-aip` key.

Namespacing is not decoration. ERC-8004 is a draft and will grow fields; a bare
`capabilities` at the top level would collide the day it adds one, and the collision would
be silent — both sides would read a key that means something different to each. The `x-`
convention is the same one OpenAPI uses for the same reason.

`x-aip` carries its own `type`, mirroring how ERC-8004 identifies its own schema. A reader
that does not recognise that string **MUST ignore the whole object** rather than guess at
its shape. That is the versioning rule: a v2 extension changes the `type`, old readers skip
it and fall back to the ERC-8004 fields, which are enough to display and contact an agent.
Cards do not need a migration; readers dispatch.

## Prices are strings

`pricing.amount` is a decimal **string**. JSON numbers are IEEE 754 doubles, and `0.1` is
not `0.1` in a double. A card is read by a client that may show the price, compare it, or
put it in an x402 payment requirement; a value that rounds differently in two languages is
a bug waiting for a decimal that does not fit. `token` and `network` are explicit for the
same reason — the predecessor hardcoded `"network": "solana"`, which names a chain family
rather than a chain, and would have been ambiguous the moment a second Solana cluster
mattered. CAIP-2 `eip155:5042002` names exactly one chain.

## The agent wallet is not in the card

AIP's `wallet_address` was the agent's signing key, allowed to differ from the owner.
ERC-8004 has a reserved place for it and it is **on-chain, not in this document**:

```solidity
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)
function getAgentWallet(uint256 agentId) returns (address)
function unsetAgentWallet(uint256 agentId)
```

Setting it requires the new wallet to prove control — EIP-712 for an EOA, ERC-1271 for a
contract wallet. So the flow is:

1. The owner picks the wallet address.
2. **That wallet** signs an EIP-712 payload binding `agentId`, `newWallet` and `deadline`.
3. The owner submits `setAgentWallet` with the signature.

Putting it in the card instead would have made it a claim: anyone can write any address
into a JSON file they control. On-chain with a signature, it is a proof. This is the one
field where ERC-8004 is strictly stronger than the record it replaces.

Two consequences worth knowing: `agentWallet` **defaults to the owner** until it is set, so
reading it back equal to `ownerOf` means "not configured", not "misconfigured"; and it is
**cleared automatically on transfer**, so a new owner starts from a clean default rather
than inheriting the previous owner's payout address.

## Endpoint domains can be verified

An endpoint in `services[]` is a claim by the owner — the card can name any domain. ERC-8004
defines an opt-in proof: publish

```
https://{endpoint-domain}/.well-known/agent-registration.json
```

containing a `registrations` list with an entry whose `agentRegistry` and `agentId` match
this agent. A consumer that fetches it over HTTPS and finds the match MAY treat the domain
as verified.

Agents serving an A2A or MCP endpoint on their own domain **SHOULD** publish it. It costs
one static file and it is the difference between "this card names atlas.example" and
"atlas.example agrees it is this agent".

## What this costs

Three things are worse than the on-chain record, and pretending otherwise would be the
wrong kind of documentation:

**Reads are no longer atomic.** The old record came back in one `getAccountInfo`. Now it is
an `eth_call` for the URI plus an HTTP or IPFS fetch, and the second can fail while the
first succeeds. Consumers must handle a card that is missing, stale or malformed — the
`did:aip` resolver treats it as a warning and returns the on-chain-derived document anyway.

**The content is mutable without a trace.** With an `https://` URI the owner can change the
card at any time and nothing on-chain records it. `ipfs://` binds the content to the CID,
but the owner can still repoint `agentURI`. Neither gives a stable document; prefer
`ipfs://` and treat the card as current-state, never as a historical claim.

**Nothing validates the card on-chain.** The registry accepts any string as the URI. A
malformed card is a client-side problem, discovered at read time by whoever fetches it.

## Validating

```bash
npx ajv-cli validate -s docs/agent-card/schema.json -d "docs/agent-card/examples/*.json" --spec=draft2020
```

The three examples are the conformance set:

- `minimal.json` — only ERC-8004's required fields, no `x-aip`. A card can be this small
  and still be valid; a reader that needs `x-aip` must cope with its absence.
- `typical.json` — one capability, A2A and DID services, x402 enabled.
- `full.json` — several capabilities at different prices, five service types, a
  cross-registration and `supportedTrust`.
