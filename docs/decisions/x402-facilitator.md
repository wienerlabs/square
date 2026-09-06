# x402 on Arc: our own in-process facilitator, not Circle Gateway or Nanopayments

**Status:** decided in [#33][i33]. Binds `packages/x402` (`@squaresdk/x402`).

[i33]: https://github.com/wienerlabs/square/issues/33

## The decision

Agent API access is paid with x402 v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
`PAYMENT-RESPONSE`, EIP-3009 `transferWithAuthorization` on Arc USDC). The
facilitator that verifies and settles those authorizations is **ours**, runs in
the gateway process, and settles every authorization on chain with the deployer
key. Replay protection lives in our Postgres, not in a third party.

Circle Nanopayments stays the documented path for sub-cent metered access once a
Circle developer account exists. The two are separated by the official
`FacilitatorClient` interface (`verify`, `settle`, `getSupported`), so moving a
route from one to the other is a configuration change, not a rewrite.

## The two options

### Circle Nanopayments (`@circle-fin/x402-batching`, `GatewayClient`)

Batches EIP-3009 authorizations off chain through Circle's API and settles the
batch through Circle Gateway: `GatewayWallet` at
`0x0077777d7EBA4688BDeF3E311b846F25870A19B9` and `GatewayMinter` at
`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` on Arc testnet. Payers deposit into
the Gateway wallet once; each request then costs no gas at all, which is what
makes sub-cent prices workable. The costs: a Circle developer account and API key
are mandatory, the running ledger sits inside Circle until a withdrawal, and the
reference sample pins its bookkeeping to Supabase.

### Our own facilitator (`createSquareFacilitator`)

Built on the official `@x402/core` facilitator and the `@x402/evm` exact scheme.
Each authorization is verified (allowlist, replay store, EIP-712 signature,
`eth_call` simulation) and then settled with one `transferWithAuthorization`
transaction paid by the facilitator key. Measured on a local anvil against the
repository's `MockUSDC3009`: **89,786 gas** for the first transfer to a fresh
recipient; the production FiatToken implementation lands around 60k on a warm
recipient. At Arc's 20 gwei native gas price that is roughly **0.0012 USDC per
settlement** (60,000 x 20 gwei), so the model is uneconomic below about
0.01 USDC per request, where gas is more than a tenth of the price. Above that it
needs no third party, works today with the deployer key, and keeps the
`(chainId, asset, payer, nonce)` replay identity in a table we own.

## Comparison

| | Own facilitator | Circle Nanopayments |
|---|---|---|
| Third-party account | None | Circle developer account + API key |
| Per-request cost to us | About 0.0012 USDC gas | Zero on chain (batched off chain) |
| Economic floor per request | About 0.01 USDC | Sub-cent |
| Where the money sits before settlement | Payer's wallet, until the tx lands | Circle Gateway wallet deposit |
| Where the ledger lives | Our Postgres (`x402_payments`) | Circle, until withdrawal |
| Replay protection | Durable store + on-chain `authorizationState` | Circle's batch ledger |
| Receipt for the client | Arc transaction hash in `PAYMENT-RESPONSE` | Batch reference from Circle |
| Latency to finality | One Arc block | Batch cadence |
| Works today | Yes, deployer key only | Needs the Circle account first |
| Failure domain | Our RPC + our key | Circle API availability |

## Why this way round

Square's settlement layer prices work in job-sized amounts (a quote, a job
submission, a dispute filing), not per token. At those sizes the gas is noise and
the on-chain hash in `PAYMENT-RESPONSE` is exactly the evidence the rest of the
protocol wants: an agent can prove it paid for a resource without trusting our
database, and a compliance reviewer can trace a payment to a block. Handing that
ledger to Circle would put a custodial hop between the payer and the receivable
the challenge window later discounts.

Metered access (per-token inference, per-row data) is real and sub-cent, and there
our model loses on gas. That is the Nanopayments case, and it is gated on
something we do not have yet: a Circle account. Rather than block the gateway on
it, the seam is the `FacilitatorClient` interface. A route that should batch
points at a Nanopayments-backed client; everything else keeps the in-process one.
Both sit behind the same `paymentMiddleware` and the same headers.

## What follows from it

- `packages/x402` ships the facilitator, the replay store (memory and Postgres),
  the Hono paid routes and the paying `fetch`. Protocol v2 only; `X-PAYMENT` v1 is
  refused.
- The replay identity is inserted **before** settlement and never downgraded once
  settled, so a replica restart or a second replica cannot serve the same
  authorization twice.
- The allowlist of `{ payTo, asset, network }` is checked in our own hook, not
  only by the library, so a misconfigured route cannot redirect funds.
- Prices below 0.01 USDC per request are a design smell under this model; they
  should be batched into a larger unit or wait for the Nanopayments client.

## What was considered and rejected

**Circle Gateway alone (no Nanopayments).** Gateway moves deposited USDC between
chains; it does not verify x402 authorizations. Using it would still require a
facilitator of our own in front of it.

**A hosted public facilitator.** It removes the gas cost from us only by moving
it to someone else's key, adds a network hop to every verify and settle, and
gives us no replay ledger of our own.
