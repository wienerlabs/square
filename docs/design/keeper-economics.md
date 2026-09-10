# Keeper economics: why the crank is paid, and the smallest job that pays it

**Status:** decided in [#21][i21]; numbers measured by the Foundry suite in
`contracts/test` and re-measured on Arc Testnet, most recently by the lifecycle
run of 2026-09-09
([lifecycle-5042002-2026-09-09.md](../deploy/lifecycle-5042002-2026-09-09.md)).
The Foundry figures and the superseded 2026-09-07 acceptance run are in
[docs/deploy/gas.md](../deploy/gas.md), from [#25][i25].

[i21]: https://github.com/wienerlabs/square/issues/21
[i25]: https://github.com/wienerlabs/square/issues/25

On Solana the crank that finalized an escrow paid a SOL fee and got rent back
when the account closed, so running it for free was roughly neutral. On Arc the
finalize transaction pays USDC gas and there is no rent to reclaim: an unpaid
crank loses money on every call and nobody runs one. The optimistic model
therefore needs a fee, and the fee has to reach the address that paid the gas.

## Where the fee comes from

ERC-8183 pays `evaluatorFeeBP` of the budget to `job.evaluator` at `complete`,
not to `msg.sender`. Our evaluator is the `KeeperEvaluator` contract, so the fee
lands in its pull-payment balance on the kernel. `KeeperEvaluator.finalize` and
`finalizeDecided` immediately call `withdrawTo(msg.sender, balance)`, so the
keeper that submitted the transaction leaves with the fee in the same
transaction. Nothing accumulates on the evaluator; the tests assert its balance
is zero after every finalize.

The fee is a snapshot taken at `fund`, so an admin change never alters what a
job already in flight will pay.

## What one finalize costs

The numbers that matter are the receipts of the lifecycle run of 2026-09-09
against the **2026-09-09 stack**, with the real ERC-8004 registries rather than
mocks ([lifecycle-5042002-2026-09-09.md](../deploy/lifecycle-5042002-2026-09-09.md)).
All four carry an effective gas price of exactly 21.0 gwei, and the native unit
is USDC with 18 decimals, so one gas costs 2.1 × 10⁻⁸ USDC.

| Path | Gas (receipt) | USDC at 21.0 gwei |
|---|---|---|
| `KeeperEvaluator.finalize`, optimistic | 449 893 | 0.00945 |
| `KeeperEvaluator.finalizeDecided`, provider wins | 413 517 | 0.00868 |
| `KeeperEvaluator.finalizeDecided`, split payout | 411 350 | 0.00864 |
| `KeeperEvaluator.finalize`, payout to a receivable buyer | 350 831 | 0.00737 |

These replace the receipts of the 2026-09-07 acceptance run, which this section
used to quote as "the deployed stack" while the stack had been redeployed twice
since ([redeploy-2026-09-08.md](../deploy/redeploy-2026-09-08.md),
[redeploy-2026-09-09.md](../deploy/redeploy-2026-09-09.md)). Naming the stack by
its date rather than by "deployed" is the point: a redeploy is what ages these
figures, and [docs/deploy/README.md](../deploy/README.md) lists what else it
ages.

The four did not move together. Optimistic `finalize` fell from 465 486 to
449 893 gas, and the other three rose. That is #145 changing the settlement path
itself, not measurement noise: hook calls on `complete` and `reject` became
tolerant, and `_resolvePayout` moved onto `complete`'s path. No single
coefficient corrects the old table, which is why all four figures are taken
again.

The Foundry suite measures the same calls against mock registries and lands
lower, so treat it as a floor rather than a forecast: `finalize` 417 852 gas
(1 068 814 for a deliberately runaway compliance module hitting the hook limit),
`finalizeDecided` 470 669, `SquareJob.complete` alone without the hook 203 123,
`SquareHook.recordExpiry` 47 953. The difference on `finalize` is the registry
writes being real and touching a storage slot for the first time.

## The smallest job that pays

The keeper breaks even when `budget × evaluatorFeeBP / 10 000 ≥ gas cost`, and
the gas cost to use is the measured optimistic `finalize`: 449 893 gas at
21.0 gwei is 0.009447753 USDC.

| `evaluatorFeeBP` | break-even budget (finalize, 0.009447753 USDC) | with a 3× margin for gas spikes |
|---|---|---|
| 25 (0.25 %) | 3.78 USDC | 11.3 USDC |
| **50 (0.5 %, default)** | **1.89 USDC** | **5.7 USDC** |
| 100 (1 %) | 0.94 USDC | 2.8 USDC |

This table has now been wrong in both directions, which is why it is derived
from receipts rather than estimated. It first quoted 1.68 USDC at the default
fee, from the pre-measurement Foundry figure of 417 852 gas at 20 gwei, and that
was 23 % optimistic against the chain. It then quoted 2.06 USDC from the
2026-09-07 receipts at 22.1728 gwei, which two redeploys and #145 left 9 %
pessimistic. Being pessimistic only costs a keeper work it could have taken, so
neither number stranded anyone's money, but a floor that is not the floor is not
worth publishing.

A job below the break-even is not broken, it is simply never finalized by a
rational keeper: the client can still `claimRefund` after expiry, and the
provider can still list the receivable.

The threshold is computed by `minimumProfitableBudget` in
`services/keeper/src/decide.ts`:

```ts
minimumProfitableBudget(evaluatorFeeBP: number, gasPriceWei: bigint, gas: bigint, marginBps = 0): bigint | null
```

It returns the smallest budget in USDC base units whose evaluator fee covers
`gas × gasPriceWei` plus `marginBps`, and `null` when `evaluatorFeeBP` is zero
or negative, because no budget makes a zero fee profitable. `null` rather than a
sentinel number: the natural use of a floor is `budget >= floor`, and the `-1n`
this function used to return made that comparison answer "every budget pays",
the exact opposite of what it meant. `packages/core` does not export
it: it is keeper-side arithmetic, not part of the SDK surface, so a client that
wants the floor before funding has to compute it the same way or ask a keeper.

The keeper service does not use the table above. It reads the live gas price on
every tick (`services/keeper/src/run.ts`) and multiplies it by `FINALIZE_GAS`,
which defaults to 450 000 against the measured 449 893: 107 gas apart, where it
was 15 486 gas under the 2026-09-07 receipt. The gap between that assumption and
the receipt is exported as `square_finalize_gas_gap`, so a constant that drifts
away from the chain shows up as a metric rather than as a keeper that quietly
finalizes at a loss. That the default is now almost exactly right is a
coincidence of #145's arithmetic, not a reason to stop watching the metric.

## Why this is enough and sponsorship is not needed for the keeper

The keeper is paid in USDC by the kernel and pays gas in USDC on Arc. With the
default fee it is profitable on any job above a few USDC and the profitability
check in the keeper service (#42) skips the rest. An ERC-4337 sponsor for the
keeper would move the same cost to a paymaster with no benefit; the measurement
in [erc4337-sponsorship.md](../decisions/erc4337-sponsorship.md) is about agents,
not keepers.

## Permissionless by construction

`finalize` and `finalizeDecided` take no role. Anyone who watches the chain and
sees a closed window can call them and be paid. The reference keeper in
`services/keeper` is one implementation; running a second one is a matter of
pointing it at the same contracts, and the fee goes to whichever lands first.
