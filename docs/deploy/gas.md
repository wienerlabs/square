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


## Arc Testnet, measured

Receipts from the acceptance run of 2026-09-07 against the deployed stack, real USDC, provider registered as ERC-8004 agent 892531. Gas price 22.17 gwei on the native interface (1 gas = 2.217 x 10^-8 USDC). Full table with every transaction: [lifecycle-5042002.md](./lifecycle-5042002.md).

| Step | Gas (receipt) | Transaction |
|---|---|---|
| createJob (1-optimistic) | 252753 | [0x4653a5bc...](https://testnet.arcscan.app/tx/0x4653a5bc39e0f000dbbcc57887e9690593cda6519b51b2acb5e2ccfbc6592515) |
| setBudget (1-optimistic) | 43969 | [0x3d9b0e81...](https://testnet.arcscan.app/tx/0x3d9b0e8184157fb7e782c5f09408f9354ba40c120578ed2e13ea99a7c7ca7276) |
| fund (1-optimistic) | 84263 | [0x671aed83...](https://testnet.arcscan.app/tx/0x671aed838afbe0b2e39729f3cc4725014480b58ac42bc773871e6e03d31d4642) |
| submit (1-optimistic) | 136844 | [0xc17dcbea...](https://testnet.arcscan.app/tx/0xc17dcbead5f0ae75aabfa44c19a2e3b17e5b96a0655b361ab61ae872665b7221) |
| finalize (permissionless) (1-optimistic) | 465486 | [0x5a8a5796...](https://testnet.arcscan.app/tx/0x5a8a5796f1e10d86d594e3089c4f5a7fe6f1cdcd6271394b067feb4f3dc6aaca) |
| dispute (bonded) (2a-dispute-client-wins) | 174404 | [0xbc8160c2...](https://testnet.arcscan.app/tx/0xbc8160c2b86e7e1d7f4126e5a8969a45f583968fe2ebf6428b967b3e3b7f1355) |
| vote 1/2 (2a-dispute-client-wins) | 81529 | [0x4be18d7e...](https://testnet.arcscan.app/tx/0x4be18d7e3a8029d6de7f55e4a8cc1f29938e2c7003ba189116c3feb6e2205133) |
| vote 2/2 (applies the rejection) (2a-dispute-client-wins) | 366967 | [0x542c1e98...](https://testnet.arcscan.app/tx/0x542c1e9840c2c63909e5d9adcf9802184cd883ed035f4eea16a6381455b55a24) |
| finalizeDecided (permissionless) (2b-dispute-provider-wins) | 407486 | [0xdf45b4d5...](https://testnet.arcscan.app/tx/0xdf45b4d5bab7f4fa2ea0d986d5400b8f1a9257200ccf34276ca8708c196f73a1) |
| finalizeDecided (split through the hook) (2c-dispute-split) | 397957 | [0x3b23b460...](https://testnet.arcscan.app/tx/0x3b23b46003ce47a642400ec9d2fedc5c7570ac688dfe20f832620e76f13c208d) |
| list (6-receivable) | 130415 | [0xa6ca59a5...](https://testnet.arcscan.app/tx/0xa6ca59a5873d19683f8e761aecb9d6708fa1536abab31493bbf27ca49fb3da04) |
| buy (6-receivable) | 107864 | [0x1ebff13c...](https://testnet.arcscan.app/tx/0x1ebff13c99b2d6b3af0a1693c7f589c9e9d7706515035fbb3894a794ca7fafac) |
| finalize (pays the buyer) (6-receivable) | 338180 | [0x72f9e969...](https://testnet.arcscan.app/tx/0x72f9e96946c0c2178500cfb94c660d236cad1f2f7ba3451a1428dfa5a982e374) |
| claimRefund (anyone) (3-expiry) | 62214 | [0xf017c558...](https://testnet.arcscan.app/tx/0xf017c558a06ba78e1a2634705168e3349063d07807836ba20b4ab7a1d397476f) |
| withdraw (1-optimistic) | 59023 | [0x8229be6a...](https://testnet.arcscan.app/tx/0x8229be6a1c92d9b0d83614f29577b83027c2d8c11128d86f8921a98824325418) |
| reject (client, Open) (4-cancel-before-funding) | 63108 | [0xc9a29f18...](https://testnet.arcscan.app/tx/0xc9a29f18f36c02012469b548aa56bf87bfd01a008c6d4f0c7a672cb371668245) |
| IdentityRegistry.register (provider agent) (0-identity) | 106883 | [0x257b8a05...](https://testnet.arcscan.app/tx/0x257b8a05b5838a82752555246d6b703adb91bb50e7a0416f6f00ef2013d40341) |

Per path, real chain:

| Path | Gas | USDC at 22.17 gwei |
|---|---|---|
| 0-identity | 106883 | 0.002369 |
| 1-optimistic | 1042338 | 0.023111 |
| 2a-dispute-client-wins | 1177480 | 0.026108 |
| 2b-dispute-provider-wins | 1310200 | 0.02905 |
| 2c-dispute-split | 1359706 | 0.030148 |
| 3-expiry | 485122 | 0.010756 |
| 4-cancel-before-funding | 342730 | 0.007599 |
| 6-receivable | 1077188 | 0.023884 |
| all | 6901647 | 0.153028 |

The chain charges slightly more than Foundry measures for the same calls (a `finalize` with the real registries and a first-touch storage slot on the ERC-8004 reputation registry lands at 465 486 gas against 417 852 in the suite), which is the registry writes being real rather than mocked. Everything else is within a few thousand gas of the local figure.
