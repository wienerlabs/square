# @squaresdk/hardening

Chain-agnostic security layer for Square services. Five independent modules, one package:

| Module | Defends against |
|---|---|
| `ssrf` | Server-side request forgery: loopback, LAN, link-local metadata endpoints, obfuscated IP literals, DNS rebinding, redirect laundering, unbounded responses |
| `idempotency` | Duplicate side effects from client retries, idempotency-key reuse with a different payload |
| `rateLimit` | Abuse and brute force, with counters that survive restarts and are shared across instances |
| `rpcFailover` | Single-provider RPC outages, retry storms against a dead endpoint, invisible failovers |
| `signedMessages` | Signatures reused for another actor, replayed messages, stale or premature messages, cross-chain replay |

Everything here was written from a requirements brief and public specifications (RFC 1918, RFC 4193, RFC 6890,
RFC 8785, EIP-712, the IETF RateLimit header draft). Nothing was copied from another repository, and no code in
this package derives from any other codebase. License: Apache-2.0.

## Install

```bash
npm install @squaresdk/hardening viem hono
```

`viem` and `hono` are peer dependencies. `viem` backs the RPC failover transport and EIP-712 signing; `hono` is only
needed for the two middleware factories. `undici` is a regular dependency because the SSRF-safe fetch needs a
connector whose address resolution can be pinned.

Node 20 or newer.

## SSRF-safe fetch

```ts
import { assertPublicUrl, safeFetch, safeFetchFollowingRedirects, SsrfError } from "@squaresdk/hardening";

const validated = await assertPublicUrl("https://example.com/webhook");

const response = await safeFetch("https://example.com/webhook", { method: "POST", body }, { timeoutMs: 5_000 });

const followed = await safeFetchFollowingRedirects(url, {}, { maxRedirects: 3, maxResponseBytes: 1_000_000 });
```

`assertPublicUrl` rejects, in this order and without touching DNS when it does not need to:

- any scheme other than `http:` or `https:`
- userinfo in the URL (`http://user:pw@host/`)
- ports outside the allowlist (default `80` and `443`)
- `localhost` and `*.localhost`
- IP literals that are not public, including the obfuscated forms an attacker uses to slip past string checks:
  `0x7f.1`, `2130706433`, `017700000001`, `127.1`, `[::ffff:127.0.0.1]`. The literal is parsed by this package
  before anything else looks at it; the WHATWG URL parser canonicalises most of these too, which makes two independent
  layers
- names whose resolution contains any non-public address. The lookup uses `dns.promises.lookup({ all: true })` and
  one bad address in the set is enough to refuse

The address classifier covers IPv4 unspecified, loopback, RFC 1918, CGNAT, link-local, multicast, reserved, the
documentation and benchmarking ranges, and the IPv6 equivalents: `::`, `::1`, ULA, link-local, site-local, multicast,
the discard prefix, plus every form that embeds an IPv4 address (IPv4-mapped, IPv4-compatible, 6to4, Teredo, NAT64),
which is classified by the embedded address. `classifyAddress` and `isPublicAddress` are exported so the same rules can
be reused elsewhere.

### DNS rebinding

Validating a name and then calling `fetch` on it is a race: the second resolution can return a different address.
`safeFetch` therefore never resolves twice. The addresses that passed validation are handed to an `undici.Agent` whose
`connect.lookup` answers only from that list, so the socket goes to the validated address while the `Host` header,
SNI and certificate verification still use the hostname. When the pinned address cannot be reached the request
fails; it does not fall back to a fresh resolution.

### Redirects

`safeFetch` never follows redirects. A 3xx comes back as-is and the caller decides. Passing `redirect: "follow"`
is refused up front. `safeFetchFollowingRedirects` follows up to `maxRedirects` hops and runs the full validation on
every hop, so a public host redirecting to `http://169.254.169.254/` or to a forbidden port is stopped at that hop.
It also applies the fetch rules that matter for safety: 303 and POST-to-301/302 become GET without a body,
`Authorization`, `Proxy-Authorization` and `Cookie` are dropped when the origin changes, and a body that can only be
read once is refused on 307/308 instead of being sent empty.

### Responses

Bodies are capped at `maxResponseBytes` (default 10 MiB). A declared `Content-Length` above the cap is refused before
any byte is read; otherwise the body streams through a counter that errors the stream and aborts the connection when
the cap is crossed. `timeoutMs` (default 10 s) covers connect, headers and body. Everything is reported through
`SsrfError`, whose `code` is a closed union you can switch on.

### Options

| Option | Default | Meaning |
|---|---|---|
| `allowedPorts` | `[80, 443]` | Ports the URL may target |
| `allowPrivate` | `false` | Skip the address checks. Only for tests against a local server |
| `lookup` | `dns.promises.lookup` | Replace name resolution. Tests use it to script answers |
| `timeoutMs` | `10000` | Total time budget for the request |
| `maxResponseBytes` | `10485760` | Body cap |
| `maxRedirects` | `5` | Hops for `safeFetchFollowingRedirects` |

## Idempotency

```ts
import { hashRequest, idempotencyMiddleware, postgresIdempotencyStore, withIdempotency } from "@squaresdk/hardening";

const store = postgresIdempotencyStore(pool);

app.use("/orders", idempotencyMiddleware(store, { scope: "orders", required: true, actorOf: (c) => c.get("actor") }));

const execute = withIdempotency(store, "payouts", async ({ payout }) => runPayout(payout), { ttlMs: 86_400_000 });
const outcome = await execute({ key, requestHash: hashRequest({ method, path, body, actor }), payout });
```

`hashRequest` hashes a canonical serialisation of method, path, body and actor (sorted keys, no whitespace), so
`{a:1,b:2}` and `{b:2,a:1}` are the same request and the same key sent by a different actor is not.

`withIdempotency` returns a function that:

1. replays the stored response when the key is known and the request hash matches
2. answers `{ status: 409, body: { error: "idempotency_key_reused" } }` when the key is known with a different hash
3. otherwise runs the handler and stores the result with `putIfAbsent`

Responses the `shouldStore` policy rejects (default: anything 5xx) are not stored, so a failed attempt can be retried
with the same key. Duplicates that arrive while the first one is still running inside the same process wait for it
and then replay. Across processes the store decides: `putIfAbsent` is atomic, the first writer wins, and the second
caller receives the first writer's response. A handler that is not safe to run twice concurrently across processes
should additionally take a per-key lock; the store interface deliberately does not hide that.

The Postgres store expects the table in `IDEMPOTENCY_TABLE_SQL`
(`idempotency_keys(scope, key, request_hash bytea, status, response jsonb, created_at, expires_at)`). The claim is a
single `insert ... on conflict do update ... where expires_at <= now()`, so an expired row is reclaimed in place and a
live row is never overwritten. `db` is duck-typed: anything with `query(text, params) => Promise<{ rows }>` works,
which covers `pg` pools and clients directly.

The Hono middleware reads `Idempotency-Key` (configurable), applies to `POST`, `PUT`, `PATCH` and `DELETE`, hashes the
parsed JSON body (or the raw text), marks replays with `Idempotent-Replayed: true`, and returns 400 when `required` is
set and the header is missing.

## Rate limiting

```ts
import { memoryRateLimitStore, postgresRateLimitStore, rateLimitMiddleware, rateLimiter } from "@squaresdk/hardening";

const store = postgresRateLimitStore(pool);

app.use("/api/*", rateLimitMiddleware(store, { limit: 100, windowMs: 60_000, keyOf: (c) => c.get("actor") }));

const limiter = rateLimiter(store, { limit: 5, windowMs: 3_600_000, keyOf: (job: Job) => job.tenant });
const { allowed, remaining, resetAt } = await limiter.check(job);
```

Fixed windows: the bucket for `keyOf(ctx)` is incremented for the window containing `now`, and the request is allowed
while the count is at or below `limit`. Fixed windows permit up to twice the limit across a window boundary; that is
the price of a single upsert per request and no coordination.

Durability lives in the store, not in the limiter. `memoryRateLimitStore` forgets on restart and is per process.
`postgresRateLimitStore` uses `rate_limits(bucket, window_start, count)` with
`insert ... on conflict (bucket, window_start) do update set count = rate_limits.count + 1 returning count`, so every
instance sees the same counters and a restart changes nothing. Call `prune(olderThanMs)` from a periodic job to drop
finished windows.

The middleware sets `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) on every response and
answers 429 with `Retry-After` when the limit is exceeded. `keyOf` is required on purpose: keying on
`X-Forwarded-For` is only correct behind a proxy you control, and the package should not guess that for you.

## RPC failover

```ts
import { createFailoverTransport, withRpcRetry } from "@squaresdk/hardening";
import { createPublicClient } from "viem";

const transport = createFailoverTransport(["https://rpc-a.example", "https://rpc-b.example"], {
  baseCooldownMs: 2_000,
  maxBackoffMs: 60_000,
  onFailover: (from, to, error) => metrics.increment("rpc.failover", { from, to, reason: error.name }),
});

const client = createPublicClient({ transport });
transport.getHealth();

const receipt = await withRpcRetry(() => client.getTransactionReceipt({ hash }), { attempts: 4, baseDelayMs: 250 });
```

The transport is viem's `fallback([...http(url)])` with health tracking around each endpoint. An endpoint that fails
`failureThreshold` times in a row (default 1) enters a cooldown of `baseCooldownMs * 2^n` capped at `maxBackoffMs`,
where `n` grows with every further consecutive failure and resets on the first success. Endpoints keep their
configured priority; a cooling endpoint is skipped as long as a healthier one follows it in the list, and once the
cooldown ends it is tried again. If every endpoint is cooling down the request is still sent to them in order, so a
brief outage degrades the client instead of failing it closed. `onFailover(from, to, error)` fires each time a request
moves from a failed endpoint to the next one, with the error the failed endpoint produced. `getHealth()` returns a
snapshot per endpoint: healthy flag, consecutive failures, cooldown deadline, last error and timestamps.

`transportFactory` swaps `http(url)` for anything else, which is how the tests use `custom()` transports.

`withRpcRetry(fn, options)` retries any async call with equal-jitter exponential backoff (`baseDelayMs`, `maxDelayMs`)
for `attempts` tries; `isRetryable` decides which errors are worth another attempt and `signal` stops the loop.

## Signed messages

```ts
import { memoryNonceStore, signAction, verifyAction } from "@squaresdk/hardening";

const message = { actor: account.address, action: "settle", resource: "invoice:42", nonce, issuedAt, expiresAt, chainId };
const signature = await signAction(account, message);

const result = await verifyAction({ message, signature, expectedActor: session.actor, nonceStore, expectedChainId: 5042002 });
if (!result.ok) reject(result.reason);
```

The EIP-712 type is `SquareAction { actor, action, resource, nonce, issuedAt, expiresAt, chainId }` under the domain
`{ name: "Square", version: "1", chainId }`. `verifyAction` recovers the signer and requires it to equal both
`message.actor` and `expectedActor`; a signature is therefore only ever valid for the one actor the server was already
talking to. It then checks `issuedAt <= now < expiresAt` (unix seconds) and consumes the nonce from the `NonceStore`,
which happens last so a rejected message never burns a nonce. It never throws for a bad signature: every failure is a
`{ ok: false, reason }` with one of `invalid_signature`, `actor_mismatch`, `unexpected_actor`, `not_yet_valid`,
`expired`, `nonce_reused`, `chain_mismatch`, `malformed_message`.

`memoryNonceStore` is per process; back the interface with your database for anything that runs on more than one
instance. `canonicalJson(value)` is the RFC 8785-style serialiser used by `hashRequest`, exported for reuse: sorted
keys, no whitespace, numbers exactly as JSON prints them, `toJSON` honoured, and it refuses `NaN`, `Infinity`, bigint
and top-level `undefined` rather than producing a form that could collide.

## Tests

```bash
npm test
```

All tests are hermetic. DNS is scripted through the `lookup` option, the RPC endpoints are `custom()` transports, the
Postgres stores run against a fake `db` that records the SQL it was given, and the only sockets are to a
`node:http` server on `127.0.0.1` (which requires `allowPrivate: true` for that suite). The rebinding proof scripts a
lookup that answers `127.0.0.1` once and `::1` afterwards: the request reaches the server, the lookup is called
exactly once, and a run that pins `::1` first fails instead of falling back to a resolution that would have worked.

## License

Apache-2.0
