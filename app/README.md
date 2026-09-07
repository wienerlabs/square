<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-inverse.svg">
    <img src="public/logo.svg" alt="Square" width="72" height="72">
  </picture>
</p>

# Square app

The reference web application for Square, the compliance-gated settlement protocol for autonomous agent work on Arc. It is a static Next.js export that talks to the deployed contracts through `@squaresdk/core` and to the connected wallet through wagmi. Nothing on screen is mocked: every number comes from the chain, from the optional indexer, or is shown as an honest empty state.

## What it does

| Route | Purpose |
|---|---|
| `/` | Landing page with the three settlement layers, the lifecycle and a live network strip (chain id, block, contract addresses, settlement horizon). |
| `/dashboard` | Metric tiles, a filterable jobs table (All, Open, In window, Finalizable, Completed, Disputed) and, with a wallet connected, the pull-payment balances on SquareJob and Arbitration with Withdraw buttons. |
| `/job?id=N` | The full job record, a timeline built from the record's timestamps, listing and dispute details, and every lifecycle action the connected wallet may take: set budget, fund (with automatic USDC approval), submit, finalize, dispute, vote, apply a decision, lapse, list, buy or cancel a claim, reject, claim refund, withdraw, record expiry. |
| `/new` | Create a job: provider, expiry (at least the settlement horizon away), a JSON spec hashed to `spec:0x...`, and an optional budget set right after creation. |
| `/network` | Keeper windows, fees and treasury, the arbiter set and threshold, bond parameters, registry addresses, the read path and links to the design notes. |

Static export means there are no dynamic route segments, so the job page reads its id from the query string. All data is fetched on the client with React Query and refreshed every ten seconds.

## Charts

Every chart is computed from the job records the page already reads; nothing is sampled, estimated or mocked.

| Where | Chart | Data | Library |
|---|---|---|---|
| Dashboard | Escrow flow: USDC funded per hour or day as thin rounded bars, running totals funded and submitted as smooth lines | `fundedAt`, `submittedAt` and `budget` of the most recent job records | Recharts |
| Dashboard | Pipeline by phase: budget held per phase with the job count on top | phase derived from status, challenge window and dispute flag | Recharts |
| Job | Settlement clock: the job's phases laid out in time with the live one outlined and a marker for now | record timestamps, `challengeEndsAt`, the dispute's `resolveBy` | SVG |
| Job | Payout split: net payout, client share after a decision, platform and evaluator fees | the fee basis points snapshotted at funding, `netPayout`, `providerBps` | SVG |
| Network | Keeper windows against the settlement horizon; fee basis points against the combined cap | `currentWindow`, `settlementHorizon`, `platformFeeBP`, `evaluatorFeeBP`, `MAX_TOTAL_FEE_BP` | SVG |
| Network | Settled on recent jobs: paid to payees, platform fees, evaluator fees, refunded | terminal job records and their snapshotted fees | Recharts |

The bucket of the escrow flow is an hour while the records span three days or less and a day after that. The settlement clock scales to the job's own activity; an expiry far beyond it is written under the clock instead of flattening it. Bars are 10 to 14 px pills on every chart, lines are monotone curves, and colours, type and radii come from the design tokens. Charts are drawn by [Recharts](https://recharts.org) (MIT) on SVG, which is also what the hand-drawn clock and segment bars use, so the whole page shares one rendering model.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `5042002` | `5042002` for Arc Testnet or `31337` for a local anvil. Anything else falls back to Arc Testnet. |
| `NEXT_PUBLIC_RPC_URL` | chain default | Overrides the RPC endpoint (`https://rpc.testnet.arc.io` or `http://127.0.0.1:8545`). |
| `NEXT_PUBLIC_INDEXER_URL` | unset | Base URL of the indexer read API. When set, the dashboard counts open and in-window jobs from `/jobs/open` and `/jobs/in-window`, and the network page shows `/status`. When unset, everything is read directly from the chain. |

The variables are inlined at build time. Copy `.env.example` to `.env.local` and rebuild after changing them.

## Running

Install with links so the two workspace packages are copied into `node_modules` and share one copy of viem:

```console
$ npm install --install-links
$ npm run typecheck
$ npm run build
```

`npm run build` writes the static site to `out/`. Serve it with any static file server, for example:

```console
$ python3 -m http.server 4310 --directory out
```

`npm run dev` starts the Next.js dev server for local work.

### Against Arc Testnet

The default configuration targets Arc Testnet (chain id 5042002) with the addresses carried by `@squaresdk/core` in `deployments[5042002]`. Connect an injected wallet (MetaMask or similar); the wallet button offers to add and switch to Arc Testnet when the wallet is on another chain. Gas and escrow both use USDC; the escrow paths use the 6-decimal ERC-20 interface at `0x3600000000000000000000000000000000000000`.

### Against anvil

Start anvil and deploy the settlement contracts with `contracts/script/DeploySettlement.s.sol` so the addresses match `deployments[31337]` in the SDK, then build with:

```console
$ NEXT_PUBLIC_CHAIN_ID=31337 npm run build
```

Anvil has no explorer, so addresses and transaction hashes render as plain text. Multicall batching is only used where the chain definition carries a Multicall3 address (Arc Testnet does); reads fall back to individual `eth_call` requests elsewhere.

## Layout

```
src/app/            App Router pages, layout, providers, global styles
src/components/     Design system components (PrimaryButton, GhostButton, Chip, NavPill, TabBar,
                    MetricCard, PanelCard, DataTable, StatusPill, AddressLink, AmountUsdc, TxToast,
                    EmptyState, WalletButton) and the page views under views/
src/lib/wagmi.ts    Chain definitions, wagmi config, the read-only public client
src/lib/square.ts   useSquare() and every chain read hook
src/lib/indexer.ts  Optional indexer read API client
src/lib/format.ts   USDC, address, timestamp and duration formatting
src/lib/tx.tsx      Transaction runner and toast state
```

## Design tokens

The page is a white engineering blueprint: a bright white canvas, a restrained grayscale, one lavender accent for primary actions and iris for the wallet button. Tokens live in `src/app/globals.css` as Tailwind v4 `@theme` values:

| Token | Value | Use |
|---|---|---|
| `carbon` | `#181925` | Primary text, never pure black |
| `graphite` / `ash` | `#666666` / `#999999` | Secondary and muted text |
| `fog` | `#e8e8e8` | Every 1px border and gridline |
| `linen` / `mist` | `#fafafa` / `#f5f5f5` | Alternating bands; inputs and disabled states |
| `lavender` | `#918df6` | Primary action button, active tab underline |
| `iris` | `#9580ff` | Wallet connect button |
| `mint` on `mint-wash` | `#33c758` / `#def6e4` | Completed or positive |
| `amber` | `#ffa600` | In window or pending |
| `sky` | `#2c78fc` | Open or funded |
| `magenta` | `#d6409f` | Disputes and rejected |

Type scale: caption 12, body 16, subheading 18, heading-sm 24, heading 36, heading-lg 48, display 60 with tight negative tracking. Radii: 8px inputs, 16px cards, 24px table containers, 9999px on every button, chip and pill. Amounts use tabular numbers.

Status pill labels are set in carbon on a tinted wash with a coloured dot, because the tone colours themselves do not reach a 4.5:1 contrast ratio as text on the wash.

## Font

The interface is set in Open Runde, loaded from `public/fonts` at weights 400, 500, 600 and 700. Open Runde is distributed under the SIL Open Font License 1.1; the licence text is in `public/fonts/LICENSE.txt`.
