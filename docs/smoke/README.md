# End to end: register an agent on Arc, resolve it back

This is the evidence that Phase 1 works. Escrow and compliance read agent
identity through exactly this path, so if it breaks, they break.

Two agents are registered permanently on Arc Testnet and are never
deregistered. Everything here reads them; nothing here writes.

| | agent id | agent URI | services |
|---|---|---|---|
| card | [892271](https://testnet.arcscan.app/tx/0xe9e6ff58ed6fcb39ffa83c80559b816ad297db49faa87e83ead86e6d275212c1) | the whole card, as a `data:` URI | 1 (A2A) |
| no card | [892272](https://testnet.arcscan.app/tx/0x64d494154c07ef4303a911cd5d6879bd04039d756dd731ae8180defa0727ac5e) | empty | 0 |

Both are owned by `0xa52c81e6aD0d73f001c911d906a907e5E36733A2`, a throwaway key
that exists only for this. The identifiers live in
[`agents.json`](agents.json), which the tests read, so there is one place for
them to be wrong rather than four.

## Why the card is a `data:` URI and not IPFS

A permanent test identity that depends on a gateway is a test that fails on
somebody else's bad afternoon. While writing this, `ipfs.io` returned 429 for an
unrelated agent's card, and the resolver correctly reported a warning rather
than a failure. That is the right behaviour, and it is also a warning we do not
want in a check whose whole job is to be unambiguous.

ERC-8004 allows `data:` URIs and the resolver dereferences them without leaving
the process. The card is 1109 bytes as a URI, which is not free: the string is
stored on chain, so registration cost about 0.017 USDC of gas instead of the
0.003 an empty registration costs. For one permanent agent that is a good trade
against a dependency that can rot.

Real agents should still use `ipfs://` or `https://`. This is a test fixture,
and it is optimising for something a real agent is not.

## The flow

```console
$ URI="data:application/json;base64,$(node -p "Buffer.from(JSON.stringify(require('./docs/smoke/agent-card.json'))).toString('base64')")"
$ square register --agent-uri "$URI" --yes --json
$ square resolve did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271
```

The URI encodes the card *compacted*, which is what `JSON.stringify` of the
parsed file produces and what is on chain. Piping the file through `base64`
instead would encode its indentation and trailing newline, giving a URI 260
bytes longer that no longer matches the registration. The smoke test asserts
the compact form against `tokenURI`, so a drift here fails loudly.

`register` never takes a DID. It sends `register(agentURI)`, waits for the
receipt, reads the agent id out of the ERC-721 `Transfer` event, and builds the
identifier from the chain id the RPC reported, the registry the transaction went
to, and that id. The card is fixed before the transaction is sent, which is why
it carries no `registrations[]` entry: the agent id it would have to contain
does not exist yet. `registrations` is optional in the schema, and the resolver
derives nothing from it.

## Checking it

```console
$ cd packages/cli && npm run build && npm run test:smoke
```

Runs on every pull request as the `end-to-end (Arc Testnet)` job. It asserts
four things:

1. `agent-card.json` still validates against `docs/agent-card/schema.json`.
2. The `tokenURI` on chain is byte for byte the card in this directory. Without
   this the file could drift from what was registered and every other assertion
   would still pass.
3. Both agents resolve: the right controller, both verification methods, the
   expected services, and no warnings.
4. An agent id past the end of the registry resolves to `notFound` with exit
   code 70, not to a malformed-identifier error.

It reads and never writes, so it needs no key and no gas. The write path is
covered separately by the opt-in test in `packages/cli/test/live.test.ts`, which
does need a funded key.

## Through the Universal Resolver

```console
$ docker compose -f docs/smoke/universal-resolver.compose.yml up --build -d
$ curl -s -H 'Accept: application/ld+json' \
    http://localhost:8090/1.0/identifiers/did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271
$ docker compose -f docs/smoke/universal-resolver.compose.yml down
```

The driver is built from this repository rather than pulled, because
`ghcr.io/wienerlabs/driver-did-aip` is still private (#64) and the upstream
driver entry still describes v1 (#65). Once both are done the same request works
against the public Universal Resolver with no local build.

The resolver's driver table is baked into its image and no environment variable
can add an entry, so [`uni-resolver-application.yml`](uni-resolver-application.yml)
replaces the table wholesale through `SPRING_CONFIG_ADDITIONAL_LOCATION`. The
result serves `did:aip` and nothing else, which is the point: the question is
whether the driver behaves the same inside `uni-resolver-web` as it does alone.

It does. For both agents the DID Document returned by the Universal Resolver is
identical to the one `square resolve` returns, field for field.

### One difference, and it is upstream's

| | driver alone | through the Universal Resolver |
|---|---|---|
| `invalidDid` | 400 | 400 |
| `notFound` | 404 | 404 |
| `unsupportedVersion` (a v1 DID) | 501 | **500** |

The Universal Resolver maps a known set of error codes onto HTTP statuses and
sends anything else as 500. `unsupportedVersion` is method-specific, which DID
Resolution allows, so it falls through.

Nothing is lost in the body: the response still carries
`"error": {"type": "unsupportedVersion", ...}` with our message. Only the status
line is coarser. Changing the driver to say `methodNotSupported` would get a
tidier status by stating something false, since the method *is* supported and
the identifier *is* well-formed. The status stays 501 on the driver, and #65
records the difference so nobody reads a 500 as a broken driver.
