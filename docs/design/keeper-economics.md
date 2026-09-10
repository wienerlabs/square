# Keeper economics: why the crank is paid, and the smallest job that pays it

**Status:** decided in [#21][i21]; numbers measured by the Foundry suite in
`contracts/test` and re-measured on Arc Testnet in [#25][i25]
([docs/deploy/gas.md](../deploy/gas.md)).

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

The numbers that matter are the receipts from the acceptance run of 2026-09-07
against the deployed stack, with the real ERC-8004 registries rather than mocks
([docs/deploy/gas.md](../deploy/gas.md)). Gas price 22.1728 gwei in native units,
and the native unit is USDC with 18 decimals, so one gas costs
2.21728 × 10⁻⁸ USDC.

| Path | Gas (receipt) | USDC at 22.1728 gwei |
|---|---|---|
| `KeeperEvaluator.finalize`, optimistic | 465 486 | 0.01032 |
| `KeeperEvaluator.finalizeDecided`, provider wins | 407 486 | 0.00904 |
| `KeeperEvaluator.finalizeDecided`, split payout | 397 957 | 0.00882 |
| `KeeperEvaluator.finalize`, payout to a receivable buyer | 338 180 | 0.00750 |

The Foundry suite measures the same calls against mock registries and lands
lower, so treat it as a floor rather than a forecast: `finalize` 417 852 gas
(1 068 814 for a deliberately runaway compliance module hitting the hook limit),
`finalizeDecided` 470 669, `SquareJob.complete` alone without the hook 203 123,
`SquareHook.recordExpiry` 47 953. The difference on `finalize` is the registry
writes being real and touching a storage slot for the first time.

## The smallest job that pays

The keeper breaks even when `budget × evaluatorFeeBP / 10 000 ≥ gas cost`, and
the gas cost to use is the measured optimistic `finalize`, 0.01032 USDC.

| `evaluatorFeeBP` | break-even budget (finalize, 0.01032 USDC) | with a 3× margin for gas spikes |
|---|---|---|
| 25 (0.25 %) | 4.13 USDC | 12.5 USDC |
| **50 (0.5 %, default)** | **2.06 USDC** | **6.2 USDC** |
| 100 (1 %) | 1.03 USDC | 3.1 USDC |

An earlier version of this table quoted 1.68 USDC at the default fee, derived
from the pre-measurement Foundry figure of 417 852 gas at 20 gwei. That was 23 %
optimistic against the chain.

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
which defaults to 450 000 against the measured 465 486. The gap between that
assumption and the receipt is exported as `square_finalize_gas_gap`, so a
constant that drifts away from the chain shows up as a metric rather than as a
keeper that quietly finalizes at a loss.

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
