# did:aip driver (Universal Resolver)

The DIF [Universal Resolver](https://github.com/decentralized-identity/universal-resolver)
driver for `did:aip` v2. A thin HTTP shell around
[`@squaresdk/did-resolver`](../did-resolver); all resolution logic lives there.

```
GET /1.0/identifiers/{did}   → 200 application/did+ld+json, or a mapped error
GET /health                  → 200 { status, chains }
```

## Running it

```bash
docker build -f did-aip-driver/Dockerfile -t driver-did-aip ../packages   # context is packages/
docker run -p 8080:8080 -e RPC_5042002=https://rpc.testnet.arc.io driver-did-aip
```

The build context is `packages/`, not this directory — the driver depends on
`../did-resolver` by path and Docker cannot reach outside its context.

## Configuration

| | |
|---|---|
| `RPC_<chainId>` | Endpoint for one chain, e.g. `RPC_5042002` |
| `DRIVER_RPC` | The whole map as JSON: `{"5042002":"https://…"}` |
| `DRIVER_ALLOWED_REGISTRIES` | Comma-separated registries to honour |
| `DRIVER_PORT` | 1 to 65535, default 8080 |
| `DRIVER_TIMEOUT_MS` | agentURI fetch timeout, a whole number of milliseconds, default 10000 |

Both RPC forms may be used together and `RPC_<chainId>` wins — an operator overriding one
chain should not have to restate the whole map. With no chain configured, or with any of
these set to something the table does not allow, the process **exits at boot** naming the
variable, rather than answering every request with 501: a container that starts while
misconfigured hides the problem until someone tries to resolve something. The timeout is
the one to be careful with: an unvalidated `DRIVER_TIMEOUT_MS=abc` would have reached
`setTimeout` as `NaN`, which Node runs as 1 ms, so every registration file would have
"timed out" while `/health` said ok.

## Status codes

| Resolver error | HTTP | Why |
|---|---|---|
| — | 200 | |
| `invalidDid` | 400 | |
| `notFound` | 404 | |
| `representationNotSupported` | 406 | |
| `unsupportedVersion` | 501 | Well-formed; this driver does not serve v1 |
| `unsupportedChain` | 501 | Well-formed; no RPC configured for that chain |
| `registryNotAllowed` | 403 | We declined to look. Not 404 — the agent may exist |
| `networkError` | 502 | The fault is upstream at the RPC, not in the driver |

The three non-500 mappings matter operationally: a caller that sees 5xx retries, and only
the upstream fault is worth retrying.

## Permanent test identifier

```
did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2
```

Arc Testnet, ERC-8004 Identity Registry. Used by the live checks and by the specification's
[test vectors](../../docs/did-aip/test-vectors.json). `agentId` 1 in the same registry has
an **empty** `agentURI` and must also resolve — a driver that errors on it is broken, and
it is the case implementations get wrong most often.

## Publishing

`.github/workflows/did-aip-driver.yml` builds, smoke-tests and pushes to GHCR on changes to
this package or the resolver.

Two rules carried over from the v1 driver:

- **The smoke test is hermetic.** It asserts `/health` is up and that a malformed DID
  answers 400, without contacting any chain. Two more checks were added for v2: a v1 DID
  must answer 501 rather than 400, and an unconfigured chain likewise.
- **`:latest` is never pushed.** Only `:{version}` and `:sha-{short}`. An operator running
  the Universal Resolver must be able to tell which build is deployed.

After the first successful run the GHCR package has to be made public once, by hand —
the Universal Resolver pulls anonymously.
