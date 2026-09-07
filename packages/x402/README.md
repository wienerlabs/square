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
flow, the library default). Pass `settlement: "before-handler"` to charge first
(the `upfront` flow). Prices are decimal USDC strings; `usdcAsset("0.05")` turns
one into the atomic `AssetAmount` the protocol carries.

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

`GET /health` is free. Everything in `routes` is paid. Route patterns follow the
x402 core syntax: `"GET /quote"`, `"/quote"` (any verb), `"GET /jobs/:id"`,
`"GET /files/*"`.

The facilitator key pays gas (native USDC on Arc) and does nothing else; the
payer's USDC moves straight from the payer to `payTo` inside
`transferWithAuthorization`. To mount paid routes on an existing Hono app use
`createPaidRoutes` and `app.use("*", ...)`; it returns the middleware only.

`pool` is anything with `query(text, params) => { rows, rowCount }`, for example a
`pg` `Pool`. Create the table with the exported `X402_PAYMENTS_DDL`:

```sql
create table if not exists x402_payments (
  chain_id bigint not null, asset bytea not null, payer bytea not null, nonce bytea not null,
  amount numeric not null, pay_to bytea not null, resource text not null, tx_hash bytea,
  status smallint not null, valid_before bigint not null, created_at timestamptz not null default now(),
  primary key (chain_id, asset, payer, nonce)
);
```

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
once with `PAYMENT-SIGNATURE`, and returns the final response. The client only pays
in the configured asset (Arc USDC by default) and never above
`maxAmountPerPayment`; the payer signs an authorization, it never sends a
transaction, so it needs USDC but no gas.

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
   or `failed`. A settled row is never downgraded.

So one signed header buys one response, across restarts and across gateway
replicas that share the database, and a signature that was seen but whose
settlement failed cannot be presented again: the payer signs a new authorization
instead. The chain remains the last line of defence (`authorizationState` makes
the second `transferWithAuthorization` revert), the store is the first.

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
