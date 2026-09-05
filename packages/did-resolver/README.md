# @mandate/did-resolver

W3C DID resolver for `did:aip` v2. Reads [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
Identity Registries; depends on `viem` and nothing else.

```ts
import { AipDidResolver } from "@mandate/did-resolver";

const resolver = new AipDidResolver({ rpc: { 5042002: "https://rpc.testnet.arc.io" } });

const { didDocument, didResolutionMetadata } = await resolver.resolve(
  "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2"
);
```

Specification: [`docs/did-aip/method-spec-v2.md`](../../docs/did-aip/method-spec-v2.md).
The parser tests are driven by the spec's own
[`test-vectors.json`](../../docs/did-aip/test-vectors.json), so the two cannot drift.

## What resolution does

Three `eth_call`s against one contract — `ownerOf`, `getAgentWallet`, `tokenURI` — and, if
the agent has a registration file, one fetch. That is the whole method.

## Four behaviours worth knowing

**`resolve()` never throws.** Every failure is a code in `didResolutionMetadata.error`.
Resolution gets embedded in agent-to-agent dispatch, where an exception takes down the
caller rather than just the lookup. The predecessor made the same promise and it is kept.

**An unreachable registration file is a warning, not a failure.** On-chain state is
authoritative for identity; an identity that vanishes because an IPFS gateway is down is
not censorship-resistant. You get the document derived from the chain plus a warning.

**An empty `agentURI` resolves.** Registering with the no-argument `register()` is normal —
`agentId` 1 on Arc Testnet is exactly this. You get a valid document with no services.

**A v1 (Solana) DID reports `unsupportedVersion`, never `invalidDid`.** It is well-formed;
this resolver just does not speak it, and the caller needs to tell those apart to decide
whether to try another resolver. Pass `v1Resolver` to handle it:

```ts
new AipDidResolver({ rpc, v1Resolver: async (parsed) => { /* … */ } });
```

v1 support is injected rather than bundled: pulling a Solana client into a package whose
point is reading ERC-8004 would defeat the purpose, for identifiers we are migrating away
from. The spec allows either choice (§9.2) and requires only that v1 is recognised.

## Options

| | |
|---|---|
| `rpc` | chainId → endpoint. Required. |
| `allowedRegistries` | Registries to honour. Anyone can deploy the ERC-8004 interface, so resolving successfully is not the same as being trustworthy (spec §10.1). A DID outside the list returns `registryNotAllowed` — not `notFound`, because the agent may well exist and we simply declined to look. |
| `v1Resolver` | Handler for the legacy Solana form. |
| `fetchAgentUri` | Override the dereferencer. |
| `ipfsGateway` | Default `https://ipfs.io/ipfs/`. |
| `timeoutMs` | Default 10s. |

The resolver verifies `eth_chainId` against the DID before reading. A misconfigured
endpoint would otherwise return a valid document for a *different* agent under a
correct-looking DID, with no error anywhere (spec §10.4).

`http://` agentURIs are refused. The registration file decides what a consumer believes
about an agent; fetching it over a channel anyone can rewrite makes that belief worthless.

Every chain read is pinned to one block, and that block is what
`didDocumentMetadata.versionId` reports. Reading the number afterwards would make it a
guess: a block can land between the reads and the report, and on a sub-second chain it
routinely would.

## Tests

```bash
npm test              # unit, no network
npm run test:live     # also hits Arc Testnet
```

The live suite resolves the agents named in the spec's vectors, so it checks the resolver
and the vectors at once — if the chain moves out from under the documentation, it fails.
