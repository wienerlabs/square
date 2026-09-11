# Screener

Screens addresses against sanctions lists and signs the answers
`ScreeningRegistry` accepts. It exists for #35; the decisions it implements are
in [docs/decisions/sanctions-screening.md](../../docs/decisions/sanctions-screening.md).

Once a `ScreeningRegistry` is installed in `SquareHook`, nobody is cleared
unless a screener has signed for them. `fund` reverts for a client or provider
without a fresh clean screening, and a release pays nothing to a payee without
one.

## What a request does

`POST /screen` with `{"addresses": ["0x…", …]}`, 1 to 20 addresses:

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
   and answers with the screenings, the signatures, the transaction hash, and
   `timings`: how long the source took to answer and how long the submission
   took to its receipt. #35 names the latency a release-time check adds, and
   these are the two parts of it.

Screening the same address twice in one second of chain time records only the
first. The registry keeps a record only if it is strictly newer than the one it
holds, so a stale "cleared" cannot overwrite a later "sanctioned". The second
request is answered 502, and the first record, at most a second old, stays.

It never answers "cleared" without a transaction behind it. A malformed request
is 400. A source that cannot answer, or a canary that comes back clean, is 503.
A submission that fails is 502. In every one of those cases nothing is on
chain.

## Source

TRM Labs' sanctions screening API, without a key: one request a second and 100
a day ([docs.sanctions.trmlabs.com](https://docs.sanctions.trmlabs.com/)). That
is enough for development and CI, not for production. TRM's public
documentation does not say how its free key is sent, so none is sent. Why TRM,
and what it does not cover, is in the decision record.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `RPC_URL` | yes | the chain the registry is on |
| `CHAIN_ID` | no, default 5042002 | part of the EIP-712 domain |
| `SCREENING_REGISTRY` | yes | the registry's address |
| `SCREENER_PRIVATE_KEY` | yes | signs the screenings and pays for their submission; the registry's owner must `setScreener` its address |
| `SCREENING_CANARY` | yes, no default | an address with a published designation. Which address proves the source is live is a choice the operator can defend, not one buried in the code |
| `TRM_BASE_URL` | no, default `https://api.trmlabs.com` | |
| `PORT` | no, default 3012 | |
| `SUBMIT_GAS`, `MIN_SUBMITS_FUNDED` | no, defaults 400000 and 3 | what the balance health check measures against |
| `RECEIPT_POLL_MS` | no, default 250 | how often a submission's receipt is polled for. viem's own default, for a chain that declares no block time, is 4 seconds, which on Arc is several times the confirmation it waits for |

`GET /health` reports three things: the RPC answers with the configured chain,
the registry recognises this screener, and the account can pay for a few
submissions. All three are critical.

## The keeper

With `SCREENER_URL` set, `services/keeper` asks this service to screen the
payee before every finalize on a hook that screens. Then it reads the registry:

- **Cleared:** it finalizes.
- **A fresh screening says the payee is designated:** it finalizes, and the
  release goes back to the client.
- **Neither:** it holds the job and asks again on the next tick, instead of
  finalizing into a refusal.

## Tests

- `npm test`: the hermetic tests. Malformed requests are refused before the
  source is asked, and signatures recover to the screener. Against anvil, when
  one is running, the real `ScreeningRegistry` computes the same digest and
  records what this service signs.
- `npm run test:live`: against TRM itself, two requests. A designated address
  is flagged and an unused one is not. With a canary TRM does not flag, nothing
  is signed.
