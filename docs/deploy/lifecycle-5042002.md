# Lifecycle run on chain 5042002

Run at 2026-09-08T08:51:22.690Z against https://rpc.testnet.arc.io. Gas price used for the USDC column: 21.2 gwei (1 gas = 0.0000000212 USDC).

| Path | Step | Transaction | Gas |
|---|---|---|---|
| 1-optimistic | createJob | [0xc91b4dd2...](https://testnet.arcscan.app/tx/0xc91b4dd2f7cd466087cbe8d95f4c3d544245541ada4f4fad852a6aea06c4f433) | 255001 |
| 1-optimistic | setBudget | [0x47659289...](https://testnet.arcscan.app/tx/0x476592895dbe11e7410ad0b483332d2910a9f868e49e9a70a782d16e76110ca8) | 43903 |
| 1-optimistic | fund | [0xe352390d...](https://testnet.arcscan.app/tx/0xe352390deff0aa71146fc2348ad4cf9d8c134a49c65b61069663b24404f6e016) | 84285 |
| 1-optimistic | submit | [0x38bdc392...](https://testnet.arcscan.app/tx/0x38bdc3921ed59239ee178d094f7fcfca4c2fd92753e7e2b8a6f425cee2e8066a) | 139111 |
| adversarial | finalize before the window closes: reverted with WindowOpen |  |  |
| 1-optimistic | finalize (permissionless) | [0x35db854c...](https://testnet.arcscan.app/tx/0x35db854c89067ad195ad541cbd92d21fd6af321eae91e50903fe624cac16c1cd) | 437220 |
| 1-optimistic | withdraw | [0xf0ce398c...](https://testnet.arcscan.app/tx/0xf0ce398c0eb303b04b63af807af02bbe3e962753e44acf16f3b8841e2a91c69c) | 59001 |
| 2a-dispute-client-wins | createJob | [0xaeb3d946...](https://testnet.arcscan.app/tx/0xaeb3d946bfe20d41f8f171d98f09839289c41b0cfd4de5064d15b29ac9b56be4) | 237901 |
| 2a-dispute-client-wins | setBudget | [0xb06843b3...](https://testnet.arcscan.app/tx/0xb06843b397a602f0ffc923511915daf5fc842166f947471dd2ebd28285f02673) | 43903 |
| 2a-dispute-client-wins | fund | [0x8f9e98f5...](https://testnet.arcscan.app/tx/0x8f9e98f5611d1f1032e16d92b56d5b4e735491fbffb9292fb755ee04cf225875) | 84285 |
| 2a-dispute-client-wins | submit | [0x6e4680e3...](https://testnet.arcscan.app/tx/0x6e4680e3c823556cf1182db35be5e4cc9d1bccad6609b34bbfca1988f6fe18d8) | 139111 |
| 2a-dispute-client-wins | dispute (bonded) | [0xa8eb67b4...](https://testnet.arcscan.app/tx/0xa8eb67b43e2b9befa20e30560ababc9ec9ebc741ab73905156088cf933dbf028) | 174449 |
| 2a-dispute-client-wins | vote 1/2 | [0xfe22c8f5...](https://testnet.arcscan.app/tx/0xfe22c8f511b083eaf0e2d11e7179a3615214dec79604097b115fcf3384e8fe1e) | 81529 |
| adversarial | finalizeDecided below the threshold: reverted with NotDecided |  |  |
| 2a-dispute-client-wins | vote 2/2 (applies the rejection) | [0xe9f67733...](https://testnet.arcscan.app/tx/0xe9f677333aa077a0b0317af6df3e3186e6f71596301ba9e134ca3b4d690bdddf) | 367012 |
| 2a-dispute-client-wins | withdrawBond | [0x15120561...](https://testnet.arcscan.app/tx/0x15120561249e9c59ef6f598eaa58d4f02df7cd54edbe209f123bc2556e8a4b89) | 53851 |
| 2b-dispute-provider-wins | createJob | [0x1c020b03...](https://testnet.arcscan.app/tx/0x1c020b03a33be93756c59756e73484a66d564be3e3453437a4c3e6b42c437d4c) | 237901 |
| 2b-dispute-provider-wins | setBudget | [0x187fc67e...](https://testnet.arcscan.app/tx/0x187fc67ed07fa2b3018b05c1b45f1c9eec552fa1b97885d5bf02708c0444337a) | 43903 |
| 2b-dispute-provider-wins | fund | [0xc24adb9d...](https://testnet.arcscan.app/tx/0xc24adb9dc1d9a7876babe922412e361e8aad1ec3fb1b58f639dfee73441789c7) | 84285 |
| 2b-dispute-provider-wins | submit | [0xdc33220c...](https://testnet.arcscan.app/tx/0xdc33220cede038d3dce4b4afa73074e4e564668b4eb76b5ee00014d494cf6db6) | 139099 |
| 2b-dispute-provider-wins | dispute (bonded) | [0xdac28fce...](https://testnet.arcscan.app/tx/0xdac28fce05421ec5bb2066fbf97644266bb38690e556da3197744bdb22706d1d) | 174449 |
| 2b-dispute-provider-wins | vote 1/2 | [0x5737bd12...](https://testnet.arcscan.app/tx/0x5737bd12e18f67e5158b2c74511f9d4f407210631ad7fcd2012fed058d299c33) | 81541 |
| 2b-dispute-provider-wins | vote 2/2 | [0xbc8637a8...](https://testnet.arcscan.app/tx/0xbc8637a834a46ffa9ee3f9edacfcb967796c7e03c3ab564900cfaa9e63c72f55) | 92201 |
| 2b-dispute-provider-wins | finalizeDecided (permissionless) | [0xc2b87e76...](https://testnet.arcscan.app/tx/0xc2b87e768ba87012abd76bbf4a3776b8bf585e2f3cb88d38e5d209a0acc07474) | 400937 |
| 2b-dispute-provider-wins | withdrawBond (provider takes the bond) | [0x238c9169...](https://testnet.arcscan.app/tx/0x238c9169a7074be9e74bf80241d490be6c6bd4edd98c7060d5d45f4a070c5d03) | 53851 |
| 2c-dispute-split | createJob | [0x50aae81b...](https://testnet.arcscan.app/tx/0x50aae81bc52d9a1559b9c6e29508e1a3e7cb88aaa6ef4e36d5c580ba12697558) | 237901 |
| 2c-dispute-split | setBudget | [0x1f0ebd0b...](https://testnet.arcscan.app/tx/0x1f0ebd0b4ab325ebb415995d0a8c62d267c2869b7d3c62d91fb96bcda8948466) | 43903 |
| 2c-dispute-split | fund | [0x42dc2b4e...](https://testnet.arcscan.app/tx/0x42dc2b4e59e2352f52fba2458b29b9e5b05ed733924913aaf529b01265b55c13) | 84285 |
| 2c-dispute-split | submit | [0xf5fc4690...](https://testnet.arcscan.app/tx/0xf5fc46902fc12a9ab321c0764d9c42523afab9e2fb46b13093ad2361e66cdc80) | 139111 |
| 2c-dispute-split | dispute (bonded) | [0xc6334e4a...](https://testnet.arcscan.app/tx/0xc6334e4a263675ff98b0cbe3f87ce481dbf01ab659d6efad44faaa59c065946f) | 174449 |
| 2c-dispute-split | vote 1/2 (4000 bps) | [0x91adb67e...](https://testnet.arcscan.app/tx/0x91adb67ef44e133e38aadda3a34efc9ffcbdb81468d2de7bbf4754bdd53c2130) | 81541 |
| 2c-dispute-split | vote 2/2 (4000 bps) | [0x16bd335a...](https://testnet.arcscan.app/tx/0x16bd335a1ee4631b558026594c1b0f917b22658630f8c83a85af8f17f552097c) | 92201 |
| 2c-dispute-split | finalizeDecided (split through the hook) | [0xca346044...](https://testnet.arcscan.app/tx/0xca346044bd63a2edc67410a611ea7ec1b5ce0ecd4c23050a0ec69bfc8dbfa140) | 391408 |
| 2c-dispute-split | withdrawBond (returned to the client) | [0xf8f50f11...](https://testnet.arcscan.app/tx/0xf8f50f114351cb62cc41ac2277665f0f950be8be13b27f6e52da2176e4961178) | 53851 |
| 2c-dispute-split | withdraw (client share) | [0xdd5b1904...](https://testnet.arcscan.app/tx/0xdd5b19045542c9c27d551515c18bc4dfff73ca22b3c1c4d762939fc43d729a0a) | 59001 |
| 3-expiry | createJob (short expiry) | [0x2e60937c...](https://testnet.arcscan.app/tx/0x2e60937ce502af977b6572f326ec4e709ab54637eb6be4fa9647825b5dd821fd) | 237901 |
| 3-expiry | setBudget | [0x09209a86...](https://testnet.arcscan.app/tx/0x09209a861034c4e4fd55c5c44dfd1c3e26c35f87950b0c42014f40ad507b1aff) | 43903 |
| 3-expiry | fund | [0x2c1dc4aa...](https://testnet.arcscan.app/tx/0x2c1dc4aad662697317503f3d719be945eaaa86127f6bdedca61517ebaa8194bc) | 84285 |
| adversarial | claimRefund before expiry: reverted with NotExpired |  |  |
| 4-cancel-before-funding | createJob | [0x4f74e23e...](https://testnet.arcscan.app/tx/0x4f74e23e04c20dabda357059801cc9e5eb703d4b718ec440d4e3e9164858fedd) | 237901 |
| 4-cancel-before-funding | setBudget | [0x291d832f...](https://testnet.arcscan.app/tx/0x291d832f3431b2f356b095041355258d3704c674553afb537a2492142358be79) | 43903 |
| 4-cancel-before-funding | reject (client, Open) | [0xbde42571...](https://testnet.arcscan.app/tx/0xbde4257168b267c0c1221d5e849eaa15fcd45845bf35f33e0e8a15e5b2502c76) | 63153 |
| 6-receivable | createJob | [0xbead4cd6...](https://testnet.arcscan.app/tx/0xbead4cd60bec666356d648f11068b3666bcb79e38ca1a81d48863e6d6fe483a7) | 237901 |
| 6-receivable | setBudget | [0x9e633dcd...](https://testnet.arcscan.app/tx/0x9e633dcd80cb164c3889984366f037c83e81ab2a13e077edd098c639c0c63657) | 43903 |
| 6-receivable | fund | [0x6162bca7...](https://testnet.arcscan.app/tx/0x6162bca7d75882a431e1477f989a94a5faf1f54c5eba2f2af5fedc322d7c81ef) | 84285 |
| 6-receivable | submit | [0x6f9dfb7b...](https://testnet.arcscan.app/tx/0x6f9dfb7b3219400a8f66213fbb71a890502d9a2ac9402a74c193a623d7a66f39) | 139111 |
| 6-receivable | list | [0x1305af38...](https://testnet.arcscan.app/tx/0x1305af3887530492a788bc5c0eeaadd4fbe316ede5661313070d273246bbd125) | 133620 |
| 6-receivable | buy | [0x8692a74b...](https://testnet.arcscan.app/tx/0x8692a74b73d53d594fc54d638875c1eefd5082be87fec79df912dfe408c1be0e) | 111113 |
| 6-receivable | finalize (pays the buyer) | [0x7cafb664...](https://testnet.arcscan.app/tx/0x7cafb664ed9571ba1989a2b36649f8730e1b3597f164f04b3bf4244cef9b3ceb) | 338158 |
| adversarial | createJob with a non-whitelisted hook: reverted with ExpiryInPast|HookNotWhitelisted |  |  |
| adversarial | createJob with a non-whitelisted hook and a valid expiry: reverted with HookNotWhitelisted |  |  |
| adversarial | dispute by a stranger: reverted with NotSubmitted|OnlyClient |  |  |
| adversarial | vote by a non-arbiter: reverted with AlreadyDecided|NotAnArbiter |  |  |
| adversarial | double finalize: reverted with NotSubmitted |  |  |
| 3-expiry | claimRefund (anyone) | [0x5ac6d72b...](https://testnet.arcscan.app/tx/0x5ac6d72bff0c2cd9791aa185b7273f772d7e77512905b3c9e1aab31762d80892) | 62415 |
| 3-expiry | withdraw (client) | [0xef97aa75...](https://testnet.arcscan.app/tx/0xef97aa75bcdea2f72fed2a9ee52caeab5ea2f3c6b1c70f443bfa50df13b14f95) | 59001 |

## Per path

| Path | Gas | USDC |
|---|---|---|
| 1-optimistic | 1018521 | 0.021592 |
| 2a-dispute-client-wins | 1182041 | 0.025059 |
| 2b-dispute-provider-wins | 1308167 | 0.027733 |
| 2c-dispute-split | 1357651 | 0.028782 |
| 3-expiry | 487505 | 0.010335 |
| 4-cancel-before-funding | 344957 | 0.007313 |
| 6-receivable | 1088091 | 0.023067 |
| all | 6786933 | 0.143882 |

## Deployment

| Contract | Address |
|---|---|
| squareJob | [0x32E642084dbE5C5673d7A7E5F69b6A8260e4f3da](https://testnet.arcscan.app/address/0x32E642084dbE5C5673d7A7E5F69b6A8260e4f3da) |
| keeperEvaluator | [0xD9f9137fC9B316b92762792Ad64760B4C5dD29C3](https://testnet.arcscan.app/address/0xD9f9137fC9B316b92762792Ad64760B4C5dD29C3) |
| arbitration | [0x0Ad6268d7e420Bd7c2BDBb6e1078b99CDf5c07cC](https://testnet.arcscan.app/address/0x0Ad6268d7e420Bd7c2BDBb6e1078b99CDf5c07cC) |
| claimMarket | [0x32eD0Ef1AD401DD6E622775283624438716730c0](https://testnet.arcscan.app/address/0x32eD0Ef1AD401DD6E622775283624438716730c0) |
| squareHook | [0xE61f869806Ca6121d33Ed2c9441a5449cF249198](https://testnet.arcscan.app/address/0xE61f869806Ca6121d33Ed2c9441a5449cF249198) |
| usdc | [0x3600000000000000000000000000000000000000](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| identityRegistry | [0x8004A818BFB912233c491871b3d84c89A494BD9e](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| reputationRegistry | [0x8004B663056A597Dffe9eCcC1965A193B7388713](https://testnet.arcscan.app/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| validationRegistry | [0x8004Cb1BF31DAf7788923b405b754f57acEB4272](https://testnet.arcscan.app/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) |
