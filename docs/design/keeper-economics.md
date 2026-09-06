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

Measured with `forge test --gas-report` on the full stack, hook attached,
mock ERC-8004 registries receiving the reputation and validation writes:

| Path | Gas (median) | Gas (max seen) |
|---|---|---|
| `KeeperEvaluator.finalize`, optimistic | 417 852 | 1 068 814 (a deliberately runaway compliance module hitting the hook limit) |
| `KeeperEvaluator.finalizeDecided`, after arbitration | 470 669 | 500 567 |
| `SquareJob.complete` alone, no hook | 203 123 | |
| `SquareHook.recordExpiry` | 47 953 | 193 285 |

Arc Testnet's observed gas price is 20 gwei in native units, and the native unit
is USDC with 18 decimals, so one gas costs 2 × 10⁻⁸ USDC:

| Path | USDC per call at 20 gwei |
|---|---|
| finalize | 0.0084 |
| finalizeDecided | 0.0094 |
| complete, no hook | 0.0041 |

## The smallest job that pays

The keeper breaks even when `budget × evaluatorFeeBP / 10 000 ≥ gas cost`.

| `evaluatorFeeBP` | break-even budget (finalize, 0.0084 USDC) | with a 3× margin for gas spikes |
|---|---|---|
| 25 (0.25 %) | 3.36 USDC | 10 USDC |
| **50 (0.5 %, default)** | **1.68 USDC** | **5 USDC** |
| 100 (1 %) | 0.84 USDC | 2.5 USDC |

A job below the break-even is not broken, it is simply never finalized by a
rational keeper: the client can still `claimRefund` after expiry, and the
provider can still list the receivable. The SDK and the keeper both expose the
threshold (`minimumProfitableBudget(feeBps, gasPrice)`) so a client learns the
floor before funding.

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
