# @squaresdk/did-resolver

W3C DID resolver for `did:aip` v2. Reads [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
Identity Registries; depends on `viem` and nothing else.

```ts
import { AipDidResolver } from "@squaresdk/did-resolver";

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
the agent has a registration file, one fetch. That is the whole method. If that file claims
cross-registrations, one more `tokenURI` read and one more fetch per claim, up to eight, to
check whether the counterpart claims this agent back; see below.

## Four behaviours worth knowing

**`resolve()` never throws.** Every failure is a code in `didResolutionMetadata.error`.
Resolution gets embedded in agent-to-agent dispatch, where an exception takes down the
caller rather than just the lookup. The predecessor made the same promise and it is kept.
The codes mean what they say: `notFound` is the chain's own answer (`ownerOf` reverted, or
the registry returned no data), and a transport failure, timeout or rate limit on that
same read is `networkError`, which the driver maps to a retryable 502 rather than a
cacheable 404.

**An unreachable registration file is a warning, not a failure.** On-chain state is
authoritative for identity; an identity that vanishes because an IPFS gateway is down is
not censorship-resistant. You get the document derived from the chain plus a warning, and
`didDocumentMetadata.registrationFile` is `"unavailable"`: `service` is empty and
`deactivated` unset because nothing was read, not because the file said so. Check it before
treating a missing `deactivated` as "active".
A JSON array is not a registration file either: nothing in it is `active` or `services`, so it
counts as not read, the same way. And the same shape holds one level down for the agent
wallet: `getAgentWallet` is optional in ERC-8004, so a revert is the registry saying "not
exposed" and the document is whole without it, but a transport failure on that one read
is `agentWalletUnavailable` in the warnings, because the key may be there and a document
that silently omits it hands a verifier an `assertionMethod` with the payment key missing.

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

## What the metadata says about the file

The registration file is owner-controlled input at an owner-controlled URI (spec §5), and
two fields in `didDocumentMetadata` exist so a consumer can decide how far to trust what
came out of it (#152):

**`agentUriScheme`** is the scheme of the agentURI as `tokenURI` gives it, lowercase:
`ipfs`, `https`, `data`, or whatever the chain says. An `ipfs` CID commits to the content;
an `https` document can change without any on-chain trace (spec §10.3). It is reported
whether or not the file could be read, so a policy of "services only from content-addressed
cards" is one comparison, and absent only when the agentURI is empty or has no scheme.

**`crossRegistrations`** is `{ verified, unverified }`, each a list of `did:aip` DIDs, present
when the file's `registrations[]` names at least one other agent (spec §8). These are
claims: anyone may write any `agentRegistry` into their own file, and unverified, a claim
is how an agent on a cheap chain impersonates a reputable one. A claim is `verified` only
when the round trip closes: the counterpart's registry is asked for its `tokenURI`, the file
there is fetched, and it lists this agent back. Everything else is `unverified`: the
counterpart does not list this agent, or has no file, or is not minted, or the round trip
could not be made because this resolver has no endpoint for that chain, the registry is
outside `allowedRegistries`, or a read or fetch failed. The counterpart is not resolved and
its own claims are not followed, so a chain of files cannot make resolution recurse; at most
eight claims are checked per resolution and the rest are reported unverified with a
`crossRegistrationsUnchecked` warning. Entries that name no agent are counted in a
`crossRegistrationMalformed` warning. Nothing claimed is merged into the document.

## Options

| | |
|---|---|
| `rpc` | chainId → endpoint. Required. |
| `allowedRegistries` | Registries to honour. Anyone can deploy the ERC-8004 interface, so resolving successfully is not the same as being trustworthy (spec §10.1). A DID outside the list returns `registryNotAllowed` — not `notFound`, because the agent may well exist and we simply declined to look. |
| `v1Resolver` | Handler for the legacy Solana form. |
| `fetchAgentUri` | Override the dereferencer. |
| `ipfsGateway` | Default `https://ipfs.io/ipfs/`. `https` anywhere, or `http` on loopback for a local node. |
| `timeoutMs` | Default 10s, for the whole fetch including redirects. |
| `maxAgentUriBytes` | Largest registration file read. Default 1 MiB. |
| `allowedAgentUriHosts` | Hosts a registration file may be fetched from, checked on every redirect hop. Omit to allow any public host. The gateway is exempt; where it redirects to is not. |
| `onNetworkError` | Where the cause of a failed chain read goes. The result says what failed and never where; viem puts the endpoint, API key included, into every transport error, and the result is public. Omit to drop the cause. |

The resolver verifies `eth_chainId` against the DID before reading. A misconfigured
endpoint would otherwise return a valid document for a *different* agent under a
correct-looking DID, with no error anywhere (spec §10.4).

`http://` agentURIs are refused. The registration file decides what a consumer believes
about an agent; fetching it over a channel anyone can rewrite makes that belief worthless.

The agentURI is chosen by the agent's owner and dereferenced by a public service, so the
default fetcher treats it as hostile all the way down, not only at the scheme:

- **Redirects are followed by hand**, at most five, and every hop is held to the same rule
  as the first. Node's `redirect: "follow"` would have taken an https URL to plain http on
  a single 302, because mixed-content blocking is a browser policy and not part of fetch.
- **A literal non-public address is refused before any connection is made**: loopback,
  private, link-local, CGNAT, multicast and reserved ranges, in IPv4 and IPv6, including
  the mapped, NAT64 and 6to4 forms that embed an IPv4 address, and `localhost`. The URL
  parser canonicalises octal, hex, decimal and short IPv4 forms first, so `0177.0.0.1`
  and `2130706433` are `127.0.0.1` by the time they are checked.
- **The body is read through a byte cap**, declared length first and then the stream
  itself. The timeout bounds seconds; a fast host can send a great deal in ten of them.
- **An `ipfs://` remainder must be a CID followed by plain path segments**, and the URL it
  builds must stay under the gateway's own path. `ipfs://../../admin` used to reach
  `https://ipfs.io/admin`, which on an operator's private gateway is whatever else that
  host serves.
- **Errors say why and never where.** `AgentUriError.message` carries no URL, host or
  status, because the resolver relays it to whoever asked as a warning; the status and
  the network stack's own words are on `AgentUriError.status` and `.detail` for a caller
  that owns the URI, such as the CLI checking a card before registering it.
  The chain reads keep the same rule: `networkError`'s message names the read that failed
  and nothing else, because viem writes the RPC endpoint into every transport error and on
  a hosted provider the endpoint carries the API key in its path. The cause goes to
  `onNetworkError` for the operator's log, or nowhere.

One thing this does not do: resolve hostnames. The module runs in browsers as well as in
Node, so a name that points at a private address is not caught. A deployment that needs
that guarantee runs the driver behind an egress policy, or injects a `fetchAgentUri` built
on `@squaresdk/hardening`, whose `safeFetch` pins resolved addresses and closes DNS
rebinding. That package is not a dependency here on purpose: it carries `undici` and
`@squaresdk/data`, and this package is imported by the browser app and the CLI.

Every chain read is pinned to one block, and that block is what
`didDocumentMetadata.versionId` reports. Reading the number afterwards would make it a
guess: a block can land between the reads and the report, and on a sub-second chain it
routinely would.

The guarantee has one way to fail, and it fails loudly: if the block number itself cannot
be read, resolution returns `networkError` rather than reading at `latest`. Three unpinned
reads can straddle a `Transfer`, giving a document whose `owner` is from before it and
whose `agentWallet` is from after, with no `versionId` to say so; the driver maps
`networkError` to 502, which tells the caller to retry, and a retry is the right answer to
an RPC that dropped one call.

## Tests

```bash
npm test              # unit, no network
npm run test:live     # also hits Arc Testnet
```

The live suite resolves the agents named in the spec's vectors, so it checks the resolver
and the vectors at once — if the chain moves out from under the documentation, it fails.
The vectors' `metadata` section, for `agentUriScheme` and `crossRegistrations`, runs in the
unit suite against a stub chain: every registration file in it is inline, served as a
`data:` agentURI, so those fields are held to the spec without a network.
