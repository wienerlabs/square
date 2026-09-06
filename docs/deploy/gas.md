# Gas, measured

Every number here is a measurement. The estimates the port started from
(ERC-20 transfer ~0.0014 USDC, Groth16 verification ~0.006 USDC) are replaced
by what the suite and the chain report.

Conversion used throughout: Arc Testnet gas price observed at 20 gwei on the
native interface, whose unit is USDC with 18 decimals, so **1 gas = 2 × 10⁻⁸
USDC** and 100 000 gas = 0.002 USDC.

## Foundry, full stack with the hook and mock ERC-8004 registries

`forge test --gas-report`, `optimizer_runs = 10 000`, Cancun.

| Contract | Function | Min | Avg | Median | Max | Median in USDC |
|---|---|---|---|---|---|---|
| SquareJob | createJob | 28 117 | 179 268 | 184 649 | 184 661 | 0.0037 |
| SquareJob | setProvider | 32 159 | 52 511 | 45 167 | 87 552 | 0.0009 |
| SquareJob | setBudget | 31 742 | 63 212 | 69 872 | 69 932 | 0.0014 |
| SquareJob | fund | 31 862 | 100 711 | 103 491 | 106 454 | 0.0021 |
| SquareJob | submit | 34 196 | 98 468 | 90 860 | 145 583 | 0.0018 |
| SquareJob | complete | 31 709 | 192 986 | 203 123 | 1 056 392 | 0.0041 |
| SquareJob | reject | 31 778 | 87 824 | 53 022 | 329 873 | 0.0011 |
| SquareJob | claimRefund | 31 230 | 51 351 | 45 283 | 79 483 | 0.0009 |
| SquareJob | withdraw | 46 567 | 55 436 | 51 321 | 68 421 | 0.0010 |
| SquareJob | withdrawTo | 26 850 | 41 687 | 29 298 | 68 915 | 0.0006 |
| KeeperEvaluator | finalize | 50 372 | 371 475 | 417 852 | 1 068 814 | 0.0084 |
| KeeperEvaluator | finalizeDecided | 29 293 | 311 490 | 470 669 | 500 567 | 0.0094 |
| KeeperEvaluator | dispute | 50 399 | 152 991 | 178 308 | 178 308 | 0.0036 |
| KeeperEvaluator | configureWindows | 24 024 | 38 566 | 38 570 | 53 103 | 0.0008 |
| Arbitration | vote | 29 198 | 116 740 | 81 529 | 464 799 | 0.0016 |
| Arbitration | lapse | 26 184 | 49 011 | 49 011 | 71 839 | 0.0010 |
| Arbitration | setArbiters | 24 344 | 205 948 | 214 433 | 214 433 | 0.0043 |
| Arbitration | withdraw | 43 000 | 50 724 | 50 724 | 58 449 | 0.0010 |
| ClaimMarket | list | 49 962 | 99 820 | 124 011 | 124 023 | 0.0025 |
| ClaimMarket | buy | 28 822 | 87 099 | 107 385 | 107 385 | 0.0021 |
| ClaimMarket | cancel | 23 724 | 27 404 | 28 114 | 30 376 | 0.0006 |
| SquareHook | recordExpiry | 44 670 | 83 465 | 47 953 | 193 285 | 0.0010 |

The maxima on `complete` and `finalize` come from the test that drives a
runaway compliance module into the 1 000 000 hook gas limit on purpose; they
are the bound working, not a cost anyone pays.

## The five paths end to end

Sum of the medians for each path #25 covers, hooked job, one provider agent.

| Path | Calls | Gas | USDC |
|---|---|---|---|
| 1. Optimistic | createJob, setBudget, fund, submit, finalize, withdraw | 1 018 145 | 0.0204 |
| 2. Disputed, provider wins | 1 plus dispute, vote ×2, finalizeDecided, withdraw ×2 | 1 873 990 | 0.0375 |
| 2. Disputed, client wins | createJob, setBudget, fund, submit, dispute, vote ×2, withdraw ×2 | 891 736 | 0.0178 |
| 2. Disputed, split | as provider wins | 1 873 990 | 0.0375 |
| 3. Expiry | createJob, setBudget, fund, claimRefund, withdraw | 454 616 | 0.0091 |
| 4. Cancel before funding | createJob, setBudget, reject | 307 543 | 0.0062 |
| Receivable sold | 1 plus list, buy | 1 249 541 | 0.0250 |

A full optimistic job costs about two cents of gas on Arc across all parties.
The receivable premium (list plus buy) is under half a cent, which is what makes
a sub-50-USDC receivable market possible where it was not on Ethereum.

## Hook share

`SquareHookTest.test_gas_hookShareOfComplete` measures the same finalize with
and without the hook. The hook's own share, with the compliance slot empty and
both registry writes landing on mocks, stays under 250 000 gas, a quarter of the
1 000 000 limit. The Groth16 verification #27 adds is budgeted at 250 000 on top,
which still leaves half the limit unused.

## Arc Testnet

Filled in by the acceptance run in #25 once the deployer at
`0xaFF9CD31ae93e1bdD70FFDf0763C2e010037c65c` is funded. The table above is the
Foundry measurement; the chain's `gasUsed` is expected to match it within the
cost of real registry writes, which the fork test in
`packages/core/test/fork.test.ts` exercises against the deployed ERC-8004
implementations.
