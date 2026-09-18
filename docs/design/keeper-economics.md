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

### The same finalize measured in two places

A gas assertion in the Foundry suite is measured by the runner, not by a laptop,
and the two do not agree. The same `test_gas_finalizeWithHook`, same solc 0.8.28,
same optimizer at 10 000 runs, same cancun:

| where | gas |
|---|---|
| this machine, forge 1.3.2 | 463 560 |
| ubuntu-latest, foundry stable | 556 564 |
| ubuntu-latest, under `forge coverage --ir-minimum` | about 650 000 |

The difference between the first two is roughly 90 000 and it is constant: the
change that added the evidence record moved both by about 74 000. So a bound that
is meant to catch a regression has to be set from the runner's number, because
the runner is the gate, and a bound set from a laptop is either red on arrival or
so loose it guards nothing. The coverage column has its own bound, selected by
`UNOPTIMIZED_BUILD`, because a gas figure from a build with the optimizer off
says nothing about the chain.

## The smallest job that pays

The keeper breaks even when `budget × evaluatorFeeBP / 10 000 ≥ gas cost`, and
the gas cost to use is the measured optimistic `finalize`: 449 893 gas at
21.0 gwei is 0.009447753 USDC.

| `evaluatorFeeBP` | break-even budget (finalize, 0.009447753 USDC) | with a 3× margin for gas spikes |
|---|---|---|
| 25 (0.25 %) | 3.78 USDC | 11.3 USDC |
| **50 (0.5 %, default)** | **1.89 USDC** | **5.7 USDC** |
| 100 (1 %) | 0.94 USDC | 2.8 USDC |

With a compliance module installed on the hook the same call is 2.3 times more
expensive, because the release runs the pairing twice, once for the preview the
payout split reads and once for the check that writes the bookkeeping. Measured
on anvil against a real module and a real prover: a verified release is
1 052 107 gas, a refused one 981 795, and a job whose proof is malformed 490 600.
At the same 22 gwei that is 0.0227 USDC for the verified case, and the table
moves with it.

| `evaluatorFeeBP` | break-even budget, module installed (0.0227 USDC) | with a 3× margin |
|---|---|---|
| 25 (0.25 %) | 9.08 USDC | 27.2 USDC |
| **50 (0.5 %, default)** | **4.53 USDC** | **13.6 USDC** |
| 100 (1 %) | 2.27 USDC | 6.8 USDC |

Which row applies is not a guess the operator makes. The keeper reads
`SquareHook.complianceModule()` at startup and picks the gated default when a
module is installed, and from the first receipt onward it uses a moving average
of the last `FINALIZE_GAS_SAMPLES` receipts rather than either constant. An
explicit `FINALIZE_GAS` wins over both, for an operator who knows something the
receipts do not. Until that change, a keeper on a gated stack believed every
finalize cost 450 000 gas and took every job between 2.38 and 5.44 USDC at a
loss, while its balance check funded 1.3 finalizes and claimed three (#344).

### After the evidence record

Since [#405](https://github.com/wienerlabs/square/pull/405) every settled job
writes an ERC-8004 evidence record from the hook's `afterAction`, and the
Foundry suite measures what that added, main against the change, same forge,
optimizer on:

| path | before | after | delta |
|---|---|---|---|
| hooked `finalize`, no module (`test_gas_hookShareOfComplete`) | 441 580 | 528 270 | +86 690 |
| gated `complete`, real module and verifier (`test_gas_gatedCompleteFitsTheHookLimit`) | 1 097 209 | 1 126 568 | +29 359 |

The two deltas differ because a moduleless stack wrote no validation response
before #405 and writes one now, on top of the evidence read and event that both
stacks pay. Applied to the receipts above, the 2026-09-09 optimistic `finalize`
of 449 893 becomes about 537 000 and #344's verified gated release of
1 052 107 about 1 081 500; both stay estimates until the redeployed stack's
receipts replace them, and this section will quote those when they exist.

The keeper's starting constants follow: `MODULELESS_FINALIZE_GAS` 560 000 and
`MODULELESS_FINALIZE_DECIDED_GAS` 610 000, `GATED_FINALIZE_GAS` 1 090 000 and
`GATED_FINALIZE_DECIDED_GAS` 1 140 000 (`services/keeper/src/gas.ts`): the CI
runner's reading of `test_gas_finalizeWithHook` (556 564) rounded up, and the
receipt plus the delta rounded up. At 22 gwei and the default fee the break-even
budgets are 2.46 USDC moduleless and 4.80 USDC gated, 7.4 and 14.4 with a 3×
margin. A constant that is high costs a keeper work it could have taken; one
that is low costs it money, and the receipts correct either within one finalize.

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
every tick (`services/keeper/src/run.ts`) and multiplies it by the gas it
assumes: an explicit `FINALIZE_GAS` if the operator set one, otherwise the
moving average of its last receipts, and before the first receipt the constant
for the stack it is on (560 000 moduleless, 1 090 000 gated, above). The gap
between the assumption and the receipt is exported as `square_finalize_gas_gap`
and alerted on past `MAX_GAS_OVERSHOOT_PERCENT`, so a constant that drifts away
from the chain shows up as a metric rather than as a keeper that quietly
finalizes at a loss. The 450 000 this section used to quote was 107 gas from
the 2026-09-09 receipt, a coincidence of #145's arithmetic; #405 moved the
receipt and the constant moved with it.

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
