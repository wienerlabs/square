# @squaresdk/x402

x402 v2 payment gateway for agent API access on [Arc](https://arc.io). One package
holds the three roles of the protocol so they cannot drift apart:

| Role | Export | Built on |
|---|---|---|
| Facilitator (verify + settle, in process) | `createSquareFacilitator` | `@x402/core` facilitator + `@x402/evm` exact scheme |
| Resource server (paid Hono routes) | `createPaidRoutes`, `createGatewayApp` | `@x402/hono` `paymentMiddleware` |
| Client (a `fetch` that pays) | `createPayingFetch` | `@x402/fetch` `wrapFetchWithPayment` |

Chain: Arc testnet, chain id `5042002`, CAIP-2 `eip155:5042002`. Asset: the USDC
ERC-20 at `0x3600000000000000000000000000000000000000` (6 decimals, EIP-712 domain
`USDC` / `2`, EIP-3009 `transferWithAuthorization`). Protocol: x402 **v2 only**.
The v1 `X-PAYMENT` header is not supported; a v1 payload is refused with
`unsupported_x402_version`.

The decision behind running our own facilitator instead of Circle Gateway or
Circle Nanopayments is written down in
[`docs/decisions/x402-facilitator.md`](../../docs/decisions/x402-facilitator.md).

## The flow

```
agent                          gateway (Hono)                    facilitator (in process)          Arc
  |  GET /quote                    |                                    |                            |
  | -----------------------------> |  no PAYMENT-SIGNATURE              |                            |
  | <----------------------------- |  402 + PAYMENT-REQUIRED            |                            |
  |  sign EIP-3009 authorization   |                                    |                            |
  |  GET /quote + PAYMENT-SIGNATURE|                                    |                            |
  | -----------------------------> |  verify(payload, requirements) --> |  allowlist, replay store,  |
  |                                |                                    |  signature, eth_call sim   |
  |                                |  run the route handler             |                            |
  |                                |  settle(payload, requirements) --> |  transferWithAuthorization |--> tx
  | <----------------------------- |  200 + PAYMENT-RESPONSE            |  mark settled (tx hash)    |
```

Headers, all base64-encoded JSON:

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | server to client, on 402 | `PaymentRequired`: `accepts[]` with `scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, `extra { name, version, assetTransferMethod }` |
| `PAYMENT-SIGNATURE` | client to server | `PaymentPayload`: the accepted requirement plus `authorization` and `signature` |
| `PAYMENT-RESPONSE` | server to client, on 200 | `SettleResponse`: `success`, `transaction`, `network`, `payer` |

Settlement happens **after** the route handler returns (the x402 `authorization`
flow, the library default), and that is the only supported mode.
`settlement: "before-handler"` is refused by `createPaidRoutes` and
`createGatewayApp` with an error that says why: the `upfront` flow makes the
resource server accept the payload without calling the facilitator's `verify`,
and every replay-ledger operation this package owns lives in the verify hooks,
so an upfront payment would be neither checked against the ledger nor written to
it. Prices are decimal USDC strings; `usdcAsset("0.05")` turns one into the
atomic `AssetAmount` the protocol carries.

## Running the gateway

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serve } from "@hono/node-server";
import {
  ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, arcTestnet,
  createGatewayApp, createSquareFacilitator, postgresReplayStore,
} from "@squaresdk/x402";

const account = privateKeyToAccount(process.env.X402_FACILITATOR_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });
const payTo = account.address;

const facilitator = createSquareFacilitator({
  walletClient,
  publicClient,
  network: ARC_TESTNET_NETWORK,
  replayStore: postgresReplayStore(pool),
  allowlist: [{ payTo, asset: ARC_TESTNET_USDC, network: ARC_TESTNET_NETWORK }],
  logger: console,
});

const app = createGatewayApp({
  payTo,
  network: ARC_TESTNET_NETWORK,
  facilitator,
  routes: {
    "GET /quote": { price: "0.05", description: "Quote a job", handler: (c) => c.json({ quote: "42 USDC" }) },
    "POST /jobs": { price: "1.00", description: "Submit a job", handler: (c) => c.json({ accepted: true }) },
  },
});

serve({ fetch: app.fetch, port: 8402 });
```

`GET /health` is free. Everything in `routes` is paid.

### What a route key looks like

A key is an optional verb, whitespace, and a path: `"GET /quote"`, `"/quote"` (any
verb), `"GET /jobs/:id"`, `"GET /files/*"`. Parameters may be written either as Hono's
`:id` or as Next's `[id]`; `"GET /jobs/[id]"` and `"GET /jobs/:id"` configure the same
route.

`createGatewayApp` serves each key to two consumers that must agree on it, or a paid
endpoint answers `200` with no payment: the `@x402/hono` `paymentMiddleware`, which
decides whether a request needs paying, and Hono's router, which decides which handler
runs. Both receive the output of **one** `parseRoutePattern` call, so they cannot drift:
`parseRoutePattern` uppercases the verb and rewrites `[id]` to `:id`, `routePatternKey`
puts that back together, and the canonical form both sides see is the colon one,
`"GET /jobs/:id"`. Whatever dialect you write, that is the key the payment side is
configured with and the path Hono registers.

The facilitator key pays gas (native USDC on Arc) and does nothing else; the
payer's USDC moves straight from the payer to `payTo` inside
`transferWithAuthorization`. To mount paid routes on an existing Hono app use
`createPaidRoutes` and `app.use("*", ...)`; it returns the middleware only.

`pool` is a `@squaresdk/data` `Database`: `pgDatabase(process.env.DATABASE_URL)` in a
service, `pgliteDatabase()` in a test. `postgresReplayStore` holds no SQL of its own;
it is a thin adapter over that package's `x402Payments` repository, which is the single
implementation of this ledger.

**Do not create `x402_payments` by hand.** It is defined once, in the
`@squaresdk/data` migrations (`0003_x402`, plus `0006_x402_reason` for the failure
reason), and created by `square-data migrate up` with `DATABASE_URL` set. This package
used to export the table's DDL, which was one definition too many: creating the table
first made `0003_x402` fail on `relation already exists`, and because the runner records
a migration only after its DDL succeeds, every later migration stayed unapplied.

`memoryReplayStore()` is for tests and single-process experiments only.

## Pointing a client at it

```ts
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_NETWORK, createPayingFetch, decodePaymentResponseHeader } from "@squaresdk/x402";

const payingFetch = createPayingFetch({
  account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY),
  network: ARC_TESTNET_NETWORK,
  maxAmountPerPayment: "1.00",
});

const res = await payingFetch("https://gateway.example/quote");
const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE"));
```

The wrapped `fetch` sends the request, reads the 402, signs one EIP-3009
authorization for exactly the advertised amount with a fresh random nonce, retries
once with `PAYMENT-SIGNATURE`, and returns the final response. The payer signs an
authorization, it never sends a transaction, so it needs USDC but no gas.

`maxAmountPerPayment` has no default and is required: a decimal USDC string such as
`"1.00"`. `createPayingFetch` throws rather than build a client that would sign for
whatever a 402 asks. What the client will sign for is decided by one rule of ours, and
a 402 that does not fit it is refused without a signature:

- the CAIP-2 network equals the configured one. The scheme is registered for that
  network alone, not for `eip155:*`, so a 402 naming another chain has no client at all
- the asset address equals the configured one, compared case-insensitively. Being one
  of the x402 library's built-in default assets is not enough
- the amount is a positive integer of atomic units at or below `maxAmountPerPayment`

The library's own spend controls are configured with the same asset and the same cap,
so a hostile 402 is usually refused a layer earlier, with the library's message. Either
way nothing is signed. A 402 that offers several options is still payable: the rule
filters the offers and the client takes one that fits.

## The replay guarantee

An EIP-3009 authorization is identified by `(chainId, asset, payer, nonce)`, the
tuple the token contract itself uses to reject reuse. The facilitator keeps that
identity in a durable `ReplayStore` and moves it through three states:

1. `onBeforeVerify`: if the identity already exists in the store, refuse with
   `replayed_authorization` before any signature or RPC work.
2. `onAfterVerify`: insert the identity as `accepted` (an
   `insert ... on conflict do nothing`; if the row already exists the request lost
   a race and is refused). This happens **before** settlement and before the route
   handler runs.
3. `onAfterSettle` / `onSettleFailure`: mark it `settled` with the transaction hash,
   or `failed` with a reason.

One transition rule, in one place: **`accepted` is the only state a row can leave.**
`markSettled` and `markFailed` both require the row to be `accepted` and both return
whether the update held, so a second settle, a late failure after a settlement, or a
mark for a row nobody accepted is a `false` the facilitator logs instead of a silent
no-op. `markFailed`'s reason is stored, in the `reason` column added by migration
`0006_x402_reason`, so reconciling a failure does not mean grepping logs for a
`(payer, nonce)` pair.

`has()` is deliberately status-blind: it answers "has this authorization identity ever
been presented", not "did it settle". That is what replay protection needs, because an
authorization that was accepted, or settled, or failed after being broadcast, must never
be presented a second time. It also means a row must never be left in a state that
cannot be resolved, which is what reconciliation is for.

So one signed header buys one response, across restarts and across gateway
replicas that share the database, and a signature that was seen but whose
settlement failed cannot be presented again: the payer signs a new authorization
instead. The chain remains the last line of defence (`authorizationState` makes
the second `transferWithAuthorization` revert), the store is the first.

### Reconciling a pending settlement

There is one outcome the gateway cannot resolve on the spot: the transaction was
broadcast but its receipt was not seen before the request ended, which the library
reports as `settlement_pending`. The facilitator records the transaction hash on the
still-`accepted` row and leaves it, because the payment may yet land and marking it
failed would be a lie. `reconcileSettlements` closes it later:

```ts
import { createPublicClient, http } from "viem";
import {
  arcTestnet,
  blockTimestampFromClient,
  postgresReplayStore,
  receiptStatusFromClient,
  reconcileSettlements,
} from "@squaresdk/x402";

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

const report = await reconcileSettlements({
  store: postgresReplayStore(db),
  receiptStatusOf: receiptStatusFromClient(publicClient),
  now: blockTimestampFromClient(publicClient),
  logger: console,
});
```

It reads the rows that are still `accepted`, and the first question it asks each one is
whether a transaction was ever broadcast, because that decides what an unreadable
receipt means.

| Row | Receipt | Outcome | Reason |
|---|---|---|---|
| has a `txHash` | `success` | `settled` with that hash | |
| has a `txHash` | `reverted` | `failed` | `settlement_reverted` |
| has a `txHash` | cannot be read | left `accepted`, counted `unresolved` | `settlement_receipt_unreadable` |
| no `txHash`, `validBefore` passed | not asked | `failed` | `authorization_expired` |
| no `txHash`, still valid | not asked | left `accepted`, counted `unresolved` | `awaiting_settlement` |

`authorization_expired` is written only for a row with no transaction hash. A transfer
that was never sent can never be sent once `validBefore` passes, so that row is a
genuine failure. A row that does carry a hash and whose receipt cannot be read is not:
the transaction may have been mined before `validBefore` with only this node unable to
see it, and `failed` is terminal, since `markSettled` and `markFailed` both require the
row to be `accepted` and `listUnsettled` returns only `accepted` rows. Writing it would
close a settled payment as failed and no later pass would look at it again. The row
keeps its hash and its `accepted` status instead, the unresolved reason says why, and
the next pass settles it as soon as the node catches up.

`now` defaults to the local wall clock. `blockTimestampFromClient` reads the latest
block timestamp instead, which is the clock the token contract actually compares
`validBefore` against, and is what a scheduled reconciler with a public client should
pass. The clock is read once per pass, not once per row.

It is idempotent and safe to run on a schedule beside `square-data sweep`; run it before
that sweep, which drops rows 30 days after `validBefore`.

Independently of the library's checks, `onBeforeVerify` also asserts that
`payTo`, `asset` and `network` are on the configured allowlist, that the client's
echoed `accepted` matches the server's requirements, that `authorization.to` is
the allowlisted payee, and that `authorization.value` covers the required amount.
Every rejection reason is exported as `REJECTION.*` and travels back to the client
in the `error` field of `PAYMENT-REQUIRED`.

## Tests

`npm test` is hermetic: it starts `anvil --port 8560 --chain-id 5042002`, deploys
the repository's `MockUSDC3009` (built by `forge build` in `contracts/`), and runs
the whole flow end to end, including the replay and tampering cases. `npm run
test:live` additionally runs against Arc testnet with the real USDC contract when
`ARC_TESTNET_RPC_URL`, `X402_FACILITATOR_PRIVATE_KEY` and
`X402_PAYER_PRIVATE_KEY` are set; without them the live suite skips.

## Verified on Arc Testnet

The live suite ran on 2026-09-07 against the real USDC at
`0x3600000000000000000000000000000000000000`: an unpaid request got a 402 with
`PAYMENT-REQUIRED`, the paying client signed an EIP-3009 authorization, the
in-process facilitator verified it, recorded it in the replay ledger and settled
it with `transferWithAuthorization` in transaction
[`0xf46145e280a3367ca5c4d8395b9f86dfee9a9f0a415fa09f1b5e355da04b8248`](https://testnet.arcscan.app/tx/0xf46145e280a3367ca5c4d8395b9f86dfee9a9f0a415fa09f1b5e355da04b8248)
(91 665 gas, about 0.002 USDC at 22 gwei). On Arc the payee must be an address
other than the facilitator, because the native balance that pays gas and the
ERC-20 balance are the same account: pass `X402_PAYEE_ADDRESS`.
