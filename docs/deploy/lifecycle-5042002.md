# Lifecycle run on chain 5042002

Run at 2026-09-09T14:40:02.527Z against https://rpc.testnet.arc.io. Gas price used for the USDC column: 21.2 gwei (1 gas = 0.0000000212 USDC).

| Path | Step | Transaction | Gas |
|---|---|---|---|
| 1-optimistic | createJob | [0xcf3f57aa...](https://testnet.arcscan.app/tx/0xcf3f57aa8cda4ae51a685e92e63cea2932bd64dd0187e00459032949cad32ff7) | 275284 |
| 1-optimistic | setBudget | [0x5c82e5ed...](https://testnet.arcscan.app/tx/0x5c82e5ed3fdf1a9a429671d42d19476593695f408a755322fcb0c8214e1f9dcd) | 43950 |
| 1-optimistic | fund | [0x88d6ce58...](https://testnet.arcscan.app/tx/0x88d6ce58d9bb540b7eb01472ca1cf1dde75bb73841c027f313774eeee757c1f5) | 84332 |
| 1-optimistic | submit | [0x282acc26...](https://testnet.arcscan.app/tx/0x282acc26d8689bcd9325963cf66a957974da046e5a263301c035e63edb5ff3b0) | 129320 |
| adversarial | finalize before the window closes: reverted with WindowOpen |  |  |
| 1-optimistic | finalize (permissionless) | [0xbaf0c8fc...](https://testnet.arcscan.app/tx/0xbaf0c8fc05daafee3f9f43b13cb72c6d9bc73b273b0cb239ca5c380f845a5a7f) | 449893 |
| 1-optimistic | withdraw | [0xaacd2d60...](https://testnet.arcscan.app/tx/0xaacd2d6037740d4c0270e427d2b335d5d45dbc5f8fe9e4a8019ec8542844b104) | 59001 |
| 2a-dispute-client-wins | createJob | [0x0ae5e10b...](https://testnet.arcscan.app/tx/0x0ae5e10bc28f0b58e08175b512c982518520a304fe488e40decd98b22ba0f2c9) | 258184 |
| 2a-dispute-client-wins | setBudget | [0x3bf30423...](https://testnet.arcscan.app/tx/0x3bf30423a600f553e50c0b89106ca27c4698ef753b31d5278394de496bfee13a) | 43950 |
| 2a-dispute-client-wins | fund | [0x8feb1a89...](https://testnet.arcscan.app/tx/0x8feb1a89d1a210326d90a9aac9ee1042d5dace897dca032519b6e9f80f32a190) | 84332 |
| 2a-dispute-client-wins | submit | [0x0f8ec18a...](https://testnet.arcscan.app/tx/0x0f8ec18a3c037030d1e0b8bb3708f48b0141944b60aa35bec316868aab641abc) | 129320 |
| 2a-dispute-client-wins | dispute (bonded) | [0xacc62a65...](https://testnet.arcscan.app/tx/0xacc62a65a3fba1a8782461c26cc17b775588d8b808077a552ff8daaf4e43fe88) | 176860 |
| 2a-dispute-client-wins | vote 1/2 | [0x8907b40f...](https://testnet.arcscan.app/tx/0x8907b40f6f37cc5d584d7e4098d2b430e0dbadc532657c5a67c5ae283cfbc28a) | 81529 |
| adversarial | finalizeDecided below the threshold: reverted with NotDecided |  |  |
| 2a-dispute-client-wins | vote 2/2 (applies the rejection) | [0xd1775c0d...](https://testnet.arcscan.app/tx/0xd1775c0d3f0b244286290d0e61df42f4c533a53c93a9b0a31faf2b15cd7acf27) | 369512 |
| 2a-dispute-client-wins | withdrawBond | [0x9d2a63f6...](https://testnet.arcscan.app/tx/0x9d2a63f6a4cfacbb4cd826bbf7d4e9d42d18d73c0a97c9a44f9e4744f269bde9) | 53851 |
| 2b-dispute-provider-wins | createJob | [0x30c0cd3b...](https://testnet.arcscan.app/tx/0x30c0cd3b03c70a528d260ac596ef0d82af7b326cc9c510a7e84256f712d6ef59) | 258184 |
| 2b-dispute-provider-wins | setBudget | [0xc021b386...](https://testnet.arcscan.app/tx/0xc021b386a6a2dc3337ac270f39373857c6c120f16df74d1a2ef693c03111c926) | 43950 |
| 2b-dispute-provider-wins | fund | [0xa93a9808...](https://testnet.arcscan.app/tx/0xa93a9808944767d134f3eff05f52a168ebf130f3e04bdc51c796254be55e341d) | 84332 |
| 2b-dispute-provider-wins | submit | [0x303546db...](https://testnet.arcscan.app/tx/0x303546db38d2c7d19d8fcd0f92f94cb71c7ddcb3f03b3f3f78272465dcbe8814) | 129308 |
| 2b-dispute-provider-wins | dispute (bonded) | [0xab4cb11d...](https://testnet.arcscan.app/tx/0xab4cb11df246b14dcd3f719fc040586b5851773cb7927e29d4b11c2574eee5a4) | 176860 |
| 2b-dispute-provider-wins | vote 1/2 | [0x00259154...](https://testnet.arcscan.app/tx/0x002591544ff62393d315083bd8da126d75edefae60bfa5d9f82b296145dd1541) | 81596 |
| 2b-dispute-provider-wins | vote 2/2 | [0xc0a45052...](https://testnet.arcscan.app/tx/0xc0a450529c20cc0b8d3f28a4c61d67f45388a7b4d7cb73060980c0ce7a9b8e8a) | 92256 |
| 2b-dispute-provider-wins | finalizeDecided (permissionless) | [0xb37dc9d4...](https://testnet.arcscan.app/tx/0xb37dc9d4cab008173bba37f18afdcea26d1d0ba6171d5a36a81681bf4258867d) | 413517 |
| 2b-dispute-provider-wins | withdrawBond (provider takes the bond) | [0x36876257...](https://testnet.arcscan.app/tx/0x368762578b21238509884186c049e376fa05b1019a9cb39ba9c8531b986c05e1) | 53851 |
| 2c-dispute-split | createJob | [0x2fdb96dd...](https://testnet.arcscan.app/tx/0x2fdb96ddaf7d7432181cc1ae332894d45944f644b196003d497cb9d37ead46da) | 258184 |
| 2c-dispute-split | setBudget | [0xef8b6555...](https://testnet.arcscan.app/tx/0xef8b65556cc09e10066858f603456dcef62d81854fa846d0932b7207795387c7) | 43950 |
| 2c-dispute-split | fund | [0xcd9f96d5...](https://testnet.arcscan.app/tx/0xcd9f96d5daa0bf66391a93ea06a1b5075d4351c87c5d766c51d77a4643dc1624) | 84332 |
| 2c-dispute-split | submit | [0xe60db6c3...](https://testnet.arcscan.app/tx/0xe60db6c34636cf068a8b08d9f5ec1d5e1cf527a4bf0cdf9bc38d80ff04c474c2) | 129320 |
| 2c-dispute-split | dispute (bonded) | [0x29aa7e9b...](https://testnet.arcscan.app/tx/0x29aa7e9baa556c270748ab5517cd9aa963327a20cedf9bfbd60b6d888690af9b) | 176860 |
| 2c-dispute-split | vote 1/2 (4000 bps) | [0xd2ba6d08...](https://testnet.arcscan.app/tx/0xd2ba6d086f06a5b983b61f2d629bc64a8158fcf2313909676ce5b1fb245d621c) | 113566 |
| 2c-dispute-split | vote 2/2 (4000 bps) | [0x08ac16b3...](https://testnet.arcscan.app/tx/0x08ac16b37cc3fc97f73b76034f8eddb4c9997372cd2e7a05b2de63dd60a97a05) | 124226 |
| 2c-dispute-split | finalizeDecided (split through the hook) | [0xac4af092...](https://testnet.arcscan.app/tx/0xac4af092c07cc4da1862da782da342f467a000a0a5e714c43c5ace8ed6297b06) | 411350 |
| 2c-dispute-split | withdrawBond (returned to the client) | [0x8ff53d14...](https://testnet.arcscan.app/tx/0x8ff53d144f10b62522b1a2bd944cbaea551090a90e749bfaec2724b273c640c9) | 53851 |
| 2c-dispute-split | withdraw (client share) | [0x9ebfe09b...](https://testnet.arcscan.app/tx/0x9ebfe09ba22887a8ab8eb34897fbbed56fa13de858eece610b78e858626cf8c3) | 59001 |
| 3-expiry | createJob (short expiry) | [0xe1d86d04...](https://testnet.arcscan.app/tx/0xe1d86d04632d732dbafa2bbdf3c508f4eb95f89fd90e9dc1410827ce8dbcba10) | 258184 |
| 3-expiry | setBudget | [0xd2ae9e08...](https://testnet.arcscan.app/tx/0xd2ae9e08805139bd369d6ff0438062c4332d993064462c835cbbaa0febf3973e) | 43950 |
| 3-expiry | fund | [0x1c00ca28...](https://testnet.arcscan.app/tx/0x1c00ca287235939ad08c47b245d763d80bac537cf4bd728a7f9f692c8f77a3f4) | 84332 |
| adversarial | claimRefund before expiry: reverted with NotExpired |  |  |
| 4-cancel-before-funding | createJob | [0x107c9bde...](https://testnet.arcscan.app/tx/0x107c9bdef11343ead63875eca0bbbb3a8f6de06cef35496614ef54119c0b08c9) | 258184 |
| 4-cancel-before-funding | setBudget | [0x044f6900...](https://testnet.arcscan.app/tx/0x044f6900d93ba7e328d2fc8832f0b5be3f08259557725328098fd9c327689e53) | 43950 |
| 4-cancel-before-funding | reject (client, Open) | [0x46a4789b...](https://testnet.arcscan.app/tx/0x46a4789b9a6b4757900166a93858c38e596e9345fd8b79eed6a025e76e9f8850) | 65608 |
| 6-receivable | createJob | [0x76130e49...](https://testnet.arcscan.app/tx/0x76130e498c4c3805c1df984b6208b5b65cdf3cf6b31683383c18c851d1864475) | 258184 |
| 6-receivable | setBudget | [0x522450fb...](https://testnet.arcscan.app/tx/0x522450fbedb52d79128018042f33e3e5070caf8f6853221af43dfd8fb653c7db) | 43950 |
| 6-receivable | fund | [0x8544d7c5...](https://testnet.arcscan.app/tx/0x8544d7c5e0da5ba847f0f564b0478dc684cab883ccd3fa5cdde41c38eb47f546) | 84332 |
| 6-receivable | submit | [0x28f95392...](https://testnet.arcscan.app/tx/0x28f953921feb0b7bd459597f44d979505cc8d00c45cf950aa2594c4758449ea7) | 129320 |
| 6-receivable | list | [0x034ef68d...](https://testnet.arcscan.app/tx/0x034ef68dddba0b66ed8c3d7a5e9af3a1ec6a290529ec50ef53de6a03d2b5b3ea) | 135989 |
| 6-receivable | buy | [0xdcb66e4d...](https://testnet.arcscan.app/tx/0xdcb66e4d6e55d5f83d7b9f919c6b97f37ee2e9c616cf64576467217a5793b619) | 113853 |
| 6-receivable | finalize (pays the buyer) | [0x07df6288...](https://testnet.arcscan.app/tx/0x07df6288ab0e810dfd2bbe844f89652dbce1331388a8940e129c6c940114c83e) | 350831 |
| adversarial | createJob with a non-whitelisted hook: reverted with ExpiryInPast|HookNotWhitelisted |  |  |
| adversarial | createJob with a non-whitelisted hook and a valid expiry: reverted with HookNotWhitelisted |  |  |
| adversarial | dispute by a stranger: reverted with NotSubmitted|OnlyClient |  |  |
| adversarial | vote by a non-arbiter: reverted with AlreadyDecided|NotAnArbiter |  |  |
| adversarial | double finalize: reverted with NotSubmitted |  |  |
| 3-expiry | claimRefund (anyone) | [0xedb28d72...](https://testnet.arcscan.app/tx/0xedb28d72d5f96ded44ad96de5dd448a2f764c534af98e26ef61cb9080a2292bb) | 62415 |
| 3-expiry | withdraw (client) | [0x7983cf05...](https://testnet.arcscan.app/tx/0x7983cf052fcbe6d5e1a41c618c5bde21ecc5b3943b8fd18e7c6a5c1ad17f80db) | 59001 |

## Per path

| Path | Gas | USDC |
|---|---|---|
| 1-optimistic | 1041780 | 0.022085 |
| 2a-dispute-client-wins | 1197538 | 0.025387 |
| 2b-dispute-provider-wins | 1333854 | 0.028277 |
| 2c-dispute-split | 1454640 | 0.030838 |
| 3-expiry | 507882 | 0.010767 |
| 4-cancel-before-funding | 367742 | 0.007796 |
| 6-receivable | 1116459 | 0.023668 |
| all | 7019895 | 0.148821 |

## Deployment

| Contract | Address |
|---|---|
| squareJob | [0x76E8690cEa9d94df810eE6b1F453866f0ee68c7B](https://testnet.arcscan.app/address/0x76E8690cEa9d94df810eE6b1F453866f0ee68c7B) |
| keeperEvaluator | [0x08100b5211463861f26aC8Bc73Df32A8A2f6ebbD](https://testnet.arcscan.app/address/0x08100b5211463861f26aC8Bc73Df32A8A2f6ebbD) |
| arbitration | [0x1c6Be0d4a84a8F0770341269393EaB13098866C2](https://testnet.arcscan.app/address/0x1c6Be0d4a84a8F0770341269393EaB13098866C2) |
| claimMarket | [0x54cd26490dF9212DC6187C73CC07132cd39A1a36](https://testnet.arcscan.app/address/0x54cd26490dF9212DC6187C73CC07132cd39A1a36) |
| squareHook | [0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6](https://testnet.arcscan.app/address/0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6) |
| usdc | [0x3600000000000000000000000000000000000000](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| identityRegistry | [0x8004A818BFB912233c491871b3d84c89A494BD9e](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| reputationRegistry | [0x8004B663056A597Dffe9eCcC1965A193B7388713](https://testnet.arcscan.app/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| validationRegistry | [0x8004Cb1BF31DAf7788923b405b754f57acEB4272](https://testnet.arcscan.app/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) |
