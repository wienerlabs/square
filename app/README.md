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
| `/` | Landing page with live numbers (jobs opened, USDC escrowed, settled, last activity), the three settlement layers, the lifecycle and a live network strip. |
| `/dashboard` | Metric tiles, the escrow flow and pipeline charts, a jobs table with phase filters, a search by id or address and a button that reads 50 older jobs at a time, and, with a wallet connected, the pull-payment balances with Withdraw buttons plus an inbox of the jobs waiting on that wallet: deliverable to submit, escrow to fund, budget to agree, challenge window open, ready to finalize, refund available. |
| `/job?id=N` | The full job record, a timeline built from the record's timestamps, listing and dispute details, a box that checks a pasted spec against the hash on chain, and every lifecycle action the connected wallet may take: set provider, set budget, fund (with automatic USDC approval), submit, finalize, dispute, vote, apply a decision, lapse, list, buy or cancel a claim, reject, claim refund, withdraw, record expiry. |
| `/new` | Create a job: provider, expiry (at least twice the settlement horizon away, so the job is still submittable after it is funded), a JSON spec hashed to `spec:0x...` that can be copied or downloaded and stays on screen after the job is created, and an optional budget set right after creation. |
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

`@squaresdk/core` and `@squaresdk/did-resolver` are `file:` dependencies and are consumed from their `dist/`, which is not committed, so on a clean checkout they have to be built before the app is installed. From the repository root:

```console
$ (cd packages/did-resolver && npm install --install-links && npm run build)
$ (cd packages/core && npm install --install-links && npm run build)
$ cd app
$ npm install --install-links
$ npm run typecheck
$ npm test
$ npm run build
```

`--install-links` copies the two workspace packages into `node_modules` instead of symlinking them, so the app and the SDK share one copy of viem. The order is the same one `.github/workflows/packages.yml` uses in its `app (static export)` job; skipping the first two steps leaves `@squaresdk/core` and `@squaresdk/did-resolver` without a build output and every import of them unresolved.

`npm test` runs the unit tests with Vitest: the phase derivation, the formatters, the chart aggregation, the wallet inbox and the live statistics are pure modules under `src/lib` and are tested without a chain.

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
src/lib/actions.ts  The gates the kernel enforces, shared by the job page, the inbox and the form
src/lib/clock.ts    The offset between the chain and the browser clock, and the skew notice threshold
src/lib/spec.ts     Checking a pasted spec against the spec: hash on chain
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

## Wallets

The wallet button discovers every wallet extension in the browser through EIP-6963 and, when there is more than one, asks which to use. The chosen wallet is remembered by its own identifier, so a person who connects with one wallet stays connected with that wallet on every page and after a reload, even when another extension owns `window.ethereum`. A browser with a single legacy wallet connects to it directly.

## Spec editor

The JSON spec on the new job page is edited in a highlighted editor: keys, strings, numbers and literals are coloured, lines are numbered, the line a parse error points at is marked, Tab inserts two spaces, and the canonical form that is hashed can be shown beside the typed form with both sizes in bytes. The text can be copied to the clipboard or downloaded as a file at any point, including from the panel that follows a successful creation.

## Spec handoff

The chain stores a hash, never the words. `createJob` writes `spec:` followed by the keccak256 of the canonical JSON of the spec (`specDescription` in `@squaresdk/core`), so the text itself never reaches the contracts, the indexer or this app, which has no server of its own. Carrying it is the client's job, and the app makes both ends of that carry explicit:

1. On `/new` the spec is copied to the clipboard or downloaded as `square-spec-<first eight hex of the hash>.json` while it is being written. After the job is created the success panel keeps the exact text that was hashed, with the same two buttons; only "Create another" clears it, once there has been a chance to save it.
2. The client sends that text to the provider over the channel the job was already agreed in. Nothing in the protocol moves it, and nothing in the protocol needs to.
3. On `/job?id=N` anyone holding a copy pastes it under "Check the spec". The page canonicalizes and hashes it exactly as the form did and says whether it is the text this job was opened with, through `specMatchesDescription` from `@squaresdk/core`. A mismatch prints the hash the pasted text actually makes, so a stale copy is told apart from a wrong one.

Without that check a provider cannot know which acceptance criterion the work will be judged by, and an arbiter reading a dispute has nothing to read. The check is where an off-chain document becomes evidence about an on-chain job.

## Clock

Every time gate on screen comes from the chain, not from the browser. `useNetwork` reads the latest block next to the job counter and keeps the offset between its timestamp and `Date.now()` at the moment of the read; `useNow` still ticks once a second off the local clock and adds that offset, so countdowns move smoothly while the second they name is the chain's. The dispute and finalize buttons, the refund gate, the dashboard inbox, the timeline and the settlement clock all derive from it.

The size of the windows is the reason. The deployed `KeeperEvaluator` runs a challenge window of 120 seconds, so a browser two minutes fast would judge the window closed the instant the provider submitted and would never draw the dispute button at all, on a chain that was still accepting the dispute. The opposite direction is harmless: the SDK simulates every write before sending it, so an action offered too early fails in simulation without spending gas.

When the two clocks differ by 30 seconds or more, a line above every page names the difference and its direction. The threshold sits well above the few seconds of block time and round trip that separate an accurate machine from the last block, and well below the 120 second window it exists to protect.

## Brand assets

`public/brand/` holds the marks of the two other parties on screen. The Arc network icon labels references to Arc Testnet, and the full Arc logo appears in the "Built on Arc" lockup at the 50 px minimum the Arc partner guidelines set, with the clear space they ask for; the footer carries the trademark line. The USDC mark labels amounts. Both are used unmodified; their provenance is in `public/brand/README.md`.

## Font

The interface is set in Open Runde, loaded from `public/fonts` at weights 400, 500, 600 and 700. Open Runde is Copyright 2023 Laurids Kern (https://github.com/lauridskern/open-runde), a rounded derivative of Inter, and is distributed under the SIL Open Font License 1.1. The licence text carrying both copyright lines is in `public/fonts/LICENSE.txt`, and the root [NOTICE](../NOTICE) lists the font with the rest of what the tree redistributes.
