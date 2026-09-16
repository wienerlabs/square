# Screener

Screens addresses against sanctions lists and signs the answers
`ScreeningRegistry` accepts. It exists for #35; the decisions it implements are
in [docs/decisions/sanctions-screening.md](../../docs/decisions/sanctions-screening.md).

Once a `ScreeningRegistry` is installed in `SquareHook`, nobody is cleared
unless a screener has signed for them. `fund` reverts for a client or provider
without a fresh clean screening, and a release pays nothing to a payee without
one.

## What a request does

`POST /screen` with `{"addresses": ["0x…", …]}`, 1 to 16 addresses. Every
request to TRM carries the canary as well, and TRM answers 413 past the canary
and 16 addresses (measured: 17 entries were answered, 18 were refused):

1. It asks the source about every address **and the canary**, in one request.
2. If the source does not flag the canary, it stops with 503 and signs nothing.
   A source that has lost its list, answers "not sanctioned" to everyone, or has
   changed shape fails here, not in production.
3. It signs one EIP-712 `Screening` per address. Each carries the source's
   answer, when it answered, the source's name, and `keccak256` of the source's
   raw response. The time is the later of the chain's latest block time and the
   screener's clock less 5 seconds, because the registry judges freshness by the
   chain's clock: a chain that has jumped ahead, as anvil does in tests, does
   not see a fresh answer as stale, and one that trails by a second does not see
   it as from the future.
4. It submits them to the registry with `submitMany`, waits for the receipt,
   and answers with the screenings, the signatures, whether this transaction
   `recorded` each one, the transaction hash, and `timings`: how long the
   source took to answer and how long the submission took to its receipt. #35
   names the latency a release-time check adds, and these are the two parts of
   it.

Screening the same address twice in one second of chain time records only the
first. The registry keeps a record only if it is strictly newer than the one it
holds, so a stale "cleared" cannot overwrite a later "sanctioned". In a batch
the repeat is skipped rather than refused: the other addresses in the request
are recorded, and the repeat comes back with `recorded: false` while its first
record, at most a second old, stands.

It never answers "cleared" without a transaction behind it. A malformed request
is 400. A source that cannot answer, or a canary that comes back clean, is 503.
A submission that fails is 502. In every one of those cases nothing is on
chain.

## Source

TRM Labs' sanctions screening API, without a key: one request a second and 100
a day ([docs.sanctions.trmlabs.com](https://docs.sanctions.trmlabs.com/)). That
is enough for development and CI, not for production. Why TRM, and what it does
not cover, is in the decision record.

### The hundred a day, and what spends it

A request carries up to 16 addresses and the canary, so the count that matters
is requests, not addresses:

- **A hire costs one**: the client, the provider and the canary go together.
- **A release costs one**: the payee and the canary.
- **A release that is held costs one per keeper tick.** The keeper asks again
  every tick for every payee it could not clear. At the default
  `POLL_INTERVAL_MS=15000` that is four a minute, so a single payee that stays
  unscreened spends the whole daily allowance in about 25 minutes.

So the free tier carries roughly fifty jobs a day *if nothing is held*, and the
held case is what exhausts it. On a shared testnet either raise
`POLL_INTERVAL_MS`, or get a key. A 429 or a 5xx from TRM makes `/screen`
answer 503 and sign nothing, so an exhausted allowance holds releases rather
than clearing anyone by mistake.

### The key path

No key is sent today: TRM's public documentation does not say how its free key
is presented, and inventing a header would be a guess that fails closed at best.
When TRM's onboarding says how, the key path is three edits and no design:

1. `services/screener/src/source.ts` reads `TRM_API_KEY` and sends it as the
   header TRM names, on the request it already builds.
2. The variable joins the table below, required in production and optional in
   development.
3. `docs/deploy/railway.md` adds it to `square-screener` as a sealed variable.

Until then the daily limit above is the operating constraint, and it belongs in
whatever the shared stack's capacity is planned against.

The request goes through `@squaresdk/hardening`'s `safeFetch`. The base URL
has to resolve to a public address, which is checked at boot and again on every
request, and the connection goes to the address that was checked. An answer is
read to 64 KiB and no further; TRM answered the largest request, 17 entries, in
1,326 bytes.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `RPC_URL` | yes | the chain the registry is on |
| `CHAIN_ID` | no, default 5042002 | part of the EIP-712 domain |
| `SCREENING_REGISTRY` | yes, unless `SQUARE_DEPLOYMENT_FILE` carries one | the registry's address |
| `SQUARE_DEPLOYMENT_FILE` | no | a deployment record written by a deploy script; its `ScreeningRegistry` is used when `SCREENING_REGISTRY` is unset, which is how the compose stack finds an address the chain only just produced |
| `SCREENER_PRIVATE_KEY` | yes | signs the screenings and pays for their submission; the registry's owner must `setScreener` its address |
| `SCREENING_CANARY` | yes, no default | an address with a published designation. Which address proves the source is live is a choice the operator can defend, not one buried in the code |
| `TRM_BASE_URL` | no, default `https://api.trmlabs.com` | must resolve to a public address; a private, loopback or link-local one stops the service at boot |
| `PORT` | no, default 3012 | |
| `SQUARE_VERSION` | no, default 0.1.0 | what `/health` and `/version` report, and what every log line carries |
| `SUBMIT_GAS`, `MIN_SUBMITS_FUNDED` | no, defaults 400000 and 3 | what the balance health check measures against |
| `RECEIPT_POLL_MS` | no, default 250 | how often a submission's receipt is polled for. viem's own default, for a chain that declares no block time, is 4 seconds, which on Arc is several times the confirmation it waits for |
| `CORS_ORIGINS` | no | comma-separated origins a browser may call `POST /screen` and `GET /health` from, such as the app's (`NEXT_PUBLIC_SCREENER_URL`); `localhost` on any port is always allowed. Any other origin gets no CORS headers, so its browser stops the call |

`GET /health` reports three things: the RPC answers with the configured chain,
the registry recognises this screener, and the account can pay for a few
submissions. All three are critical.

## The keeper

With `SCREENER_URL` set, `services/keeper` asks this service to screen the
payees of the jobs it is about to finalize on a hook that screens: once a tick,
each payee once however many jobs pay it, and 16 to a request. Then it reads
the registry for each job:

- **Cleared:** it finalizes.
- **A fresh screening says the payee is designated:** it finalizes, and the
  release goes back to the client.
- **Neither:** it holds the job and asks again on the next tick, instead of
  finalizing into a refusal.

A job whose screening cannot be read at all, because the RPC failed, is none of
these. It is a failed attempt at that job, backed off and retried like a failed
send, and the other jobs in the tick still go.

| Variable | Default | Meaning |
|---|---|---|
| `SCREENER_URL` | unset: no screening | where this service listens, e.g. `http://screener:3012` |
| `SCREENER_ALLOW_PRIVATE` | `false` | `true` lets `SCREENER_URL` resolve to a private or loopback address, as it does on a private network. A link-local address is refused either way |
| `SCREENER_TIMEOUT_MS` | 30000 | how long one request may take. A tick whose screener does not answer waits this long per request, not per job |

The keeper's `/health` then carries a critical `screener` check, which asks
this service's `/health`. A screener that is down, that the registry does not
recognise, or that cannot pay for a submission turns the keeper unhealthy,
instead of every release being held while the keeper reports green.

## Tests

- `npm test`: the hermetic tests. Malformed requests are refused before the
  source is asked, signatures recover to the screener, an answer past the byte
  cap is refused, and a base URL that is not public is never sent a request.
  Against anvil, when one is running, the real `ScreeningRegistry` computes the
  same digest, records what this service signs, and records the rest of a
  batch that repeats an address it already holds from the same second.
- `npm run test:live`: against TRM itself, two requests. A designated address
  is flagged and an unused one is not. With a canary TRM does not flag, nothing
  is signed.
