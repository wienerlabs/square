# Lifecycle run on chain 5042002

Run at 2026-09-06T23:52:31.125Z against https://rpc.testnet.arc.io. Gas price used for the USDC column: 22.1728 gwei (1 gas = 0.0000000221728 USDC).

| Path | Step | Transaction | Gas |
|---|---|---|---|
| 0-identity | IdentityRegistry.register (provider agent) | [0x257b8a05...](https://testnet.arcscan.app/tx/0x257b8a05b5838a82752555246d6b703adb91bb50e7a0416f6f00ef2013d40341) | 106883 |
| 1-optimistic | createJob | [0x4653a5bc...](https://testnet.arcscan.app/tx/0x4653a5bc39e0f000dbbcc57887e9690593cda6519b51b2acb5e2ccfbc6592515) | 252753 |
| 1-optimistic | setBudget | [0x3d9b0e81...](https://testnet.arcscan.app/tx/0x3d9b0e8184157fb7e782c5f09408f9354ba40c120578ed2e13ea99a7c7ca7276) | 43969 |
| 1-optimistic | fund | [0x671aed83...](https://testnet.arcscan.app/tx/0x671aed838afbe0b2e39729f3cc4725014480b58ac42bc773871e6e03d31d4642) | 84263 |
| 1-optimistic | submit | [0xc17dcbea...](https://testnet.arcscan.app/tx/0xc17dcbead5f0ae75aabfa44c19a2e3b17e5b96a0655b361ab61ae872665b7221) | 136844 |
| adversarial | finalize before the window closes: reverted with WindowOpen |  |  |
| 1-optimistic | finalize (permissionless) | [0x5a8a5796...](https://testnet.arcscan.app/tx/0x5a8a5796f1e10d86d594e3089c4f5a7fe6f1cdcd6271394b067feb4f3dc6aaca) | 465486 |
| 1-optimistic | withdraw | [0x8229be6a...](https://testnet.arcscan.app/tx/0x8229be6a1c92d9b0d83614f29577b83027c2d8c11128d86f8921a98824325418) | 59023 |
| 2a-dispute-client-wins | createJob | [0xdf10d48a...](https://testnet.arcscan.app/tx/0xdf10d48af135d9cdfb6a064c0065d49c081a280d34a467af5eac43e5409971a5) | 235653 |
| 2a-dispute-client-wins | setBudget | [0x1fdcc9a6...](https://testnet.arcscan.app/tx/0x1fdcc9a66a50d750a4bf4da94a8085e7371d09c7f30386e3ef0ec0ef972bd101) | 43969 |
| 2a-dispute-client-wins | fund | [0xd861a59b...](https://testnet.arcscan.app/tx/0xd861a59ba30e010e8f2e21a9b6d9f5353df4023bcd216ce57b91cf26d53ed5b3) | 84263 |
| 2a-dispute-client-wins | submit | [0xd536134f...](https://testnet.arcscan.app/tx/0xd536134f56139b97cea514704f619d9fff6abce4eb19ade4a5d155de87878b65) | 136844 |
| 2a-dispute-client-wins | dispute (bonded) | [0xbc8160c2...](https://testnet.arcscan.app/tx/0xbc8160c2b86e7e1d7f4126e5a8969a45f583968fe2ebf6428b967b3e3b7f1355) | 174404 |
| 2a-dispute-client-wins | vote 1/2 | [0x4be18d7e...](https://testnet.arcscan.app/tx/0x4be18d7e3a8029d6de7f55e4a8cc1f29938e2c7003ba189116c3feb6e2205133) | 81529 |
| adversarial | finalizeDecided below the threshold: reverted with NotDecided |  |  |
| 2a-dispute-client-wins | vote 2/2 (applies the rejection) | [0x542c1e98...](https://testnet.arcscan.app/tx/0x542c1e9840c2c63909e5d9adcf9802184cd883ed035f4eea16a6381455b55a24) | 366967 |
| 2a-dispute-client-wins | withdrawBond | [0x6fcd6220...](https://testnet.arcscan.app/tx/0x6fcd622010ea272ab3a217fea2d09692ca6d3bebe086da3bfd6cd5abcd99bbcf) | 53851 |
| 2b-dispute-provider-wins | createJob | [0xfbc9a4f5...](https://testnet.arcscan.app/tx/0xfbc9a4f5e6d3ee8a0b61dfccd2e8b6044ad664c5dc551b1aeaadc4014041e0b7) | 235653 |
| 2b-dispute-provider-wins | setBudget | [0xbacb7313...](https://testnet.arcscan.app/tx/0xbacb7313dc05d4e0a7fd6be275b6836089b619e8884b8be4906c704e7a7f06f2) | 43969 |
| 2b-dispute-provider-wins | fund | [0xe50f998f...](https://testnet.arcscan.app/tx/0xe50f998f06a86ee8a7d517908ba3090bd6f035460f7b61d2059708dd414f2169) | 84263 |
| 2b-dispute-provider-wins | submit | [0x0b8958c8...](https://testnet.arcscan.app/tx/0x0b8958c89a73e666704e559b206d854a16c0630082a3d3b576c469821d938ee8) | 136832 |
| 2b-dispute-provider-wins | dispute (bonded) | [0xc2b3f21f...](https://testnet.arcscan.app/tx/0xc2b3f21fc3f4063246c15597d6a573ebb62e48a20b00eb51b1c6f5e27dfb7df2) | 174404 |
| 2b-dispute-provider-wins | vote 1/2 | [0x1b396a8d...](https://testnet.arcscan.app/tx/0x1b396a8dc7a7a4190de03f26ea5df389a3fff0385bb1a901e794ca3193976ada) | 81541 |
| 2b-dispute-provider-wins | vote 2/2 | [0x6ac2148b...](https://testnet.arcscan.app/tx/0x6ac2148b13ff1125c8f03697509b8b71e0ec3601bd2744f304843304caf0b16c) | 92201 |
| 2b-dispute-provider-wins | finalizeDecided (permissionless) | [0xdf45b4d5...](https://testnet.arcscan.app/tx/0xdf45b4d5bab7f4fa2ea0d986d5400b8f1a9257200ccf34276ca8708c196f73a1) | 407486 |
| 2b-dispute-provider-wins | withdrawBond (provider takes the bond) | [0x23836a87...](https://testnet.arcscan.app/tx/0x23836a878e19de6aa46a25eb52279f51cb23a8d9cfbb57cbb5c2a3d607b89c3e) | 53851 |
| 2c-dispute-split | createJob | [0xed84864d...](https://testnet.arcscan.app/tx/0xed84864d7da5eee4b67cb05c81194f6d9dc1f1e89e03526de27466eab8148eb1) | 235653 |
| 2c-dispute-split | setBudget | [0xe1686197...](https://testnet.arcscan.app/tx/0xe1686197c4c50ffee7f2a670253891c8bdd7950c4d49559ae00d18ec540d72d0) | 43969 |
| 2c-dispute-split | fund | [0x896d2d6e...](https://testnet.arcscan.app/tx/0x896d2d6e3ab2c263a32546c309d82083fb501b794e2c39da4a66dd69486bfe08) | 84263 |
| 2c-dispute-split | submit | [0xe486b069...](https://testnet.arcscan.app/tx/0xe486b069fb8df7c9488ab916d62092fbbe9b74cb2d02d6717c4dfd9d2946587f) | 136844 |
| 2c-dispute-split | dispute (bonded) | [0xfb15e00f...](https://testnet.arcscan.app/tx/0xfb15e00f6b1f8bfa1144afc4bd7c2e534a4f99c5ca2f71d793ec3ea653e06a64) | 174404 |
| 2c-dispute-split | vote 1/2 (4000 bps) | [0x2cfef996...](https://testnet.arcscan.app/tx/0x2cfef996b6c9d7381e31bde33db5e30382762b113657facd50b358a24f8e16b6) | 81541 |
| 2c-dispute-split | vote 2/2 (4000 bps) | [0x92333783...](https://testnet.arcscan.app/tx/0x92333783f0842ab0634a2b0635c2cf769665e74f57fe418d040dda88c747c584) | 92201 |
| 2c-dispute-split | finalizeDecided (split through the hook) | [0x3b23b460...](https://testnet.arcscan.app/tx/0x3b23b46003ce47a642400ec9d2fedc5c7570ac688dfe20f832620e76f13c208d) | 397957 |
| 2c-dispute-split | withdrawBond (returned to the client) | [0xc12b30c6...](https://testnet.arcscan.app/tx/0xc12b30c6161a80142e9e938bf384bb967fdaac685d78e8057239227948495b17) | 53851 |
| 2c-dispute-split | withdraw (client share) | [0x0d46bdfb...](https://testnet.arcscan.app/tx/0x0d46bdfb3c04bc7fa03c252301725193c1cec8124ee33aff98b649fe000e6187) | 59023 |
| 3-expiry | createJob (short expiry) | [0xa5764628...](https://testnet.arcscan.app/tx/0xa5764628b7dd629c07d0b88fa75ab5327765a26e0fccb03298a7a3e6a36c526b) | 235653 |
| 3-expiry | setBudget | [0x12c67cd2...](https://testnet.arcscan.app/tx/0x12c67cd2f50c1c3e379332d03c953d5f8891af2ad43390600c8f70bea5a3bf70) | 43969 |
| 3-expiry | fund | [0xc6663949...](https://testnet.arcscan.app/tx/0xc6663949e252fb8adb4cb2f4241e4ba2631a7cc2d31bd6d2a1eecc2d279a2b8e) | 84263 |
| adversarial | claimRefund before expiry: reverted with NotExpired |  |  |
| 4-cancel-before-funding | createJob | [0x5cd0e7b9...](https://testnet.arcscan.app/tx/0x5cd0e7b9486d16dbeecf9eedf250405b97815a8b4e6f48a57f5d02adb9ddd5e6) | 235653 |
| 4-cancel-before-funding | setBudget | [0xc63399f4...](https://testnet.arcscan.app/tx/0xc63399f4fa07b57381cc46af9af3dc57e2adbe10ee255e3c2a5c24aa4c9e1dd5) | 43969 |
| 4-cancel-before-funding | reject (client, Open) | [0xc9a29f18...](https://testnet.arcscan.app/tx/0xc9a29f18f36c02012469b548aa56bf87bfd01a008c6d4f0c7a672cb371668245) | 63108 |
| 6-receivable | createJob | [0x69642111...](https://testnet.arcscan.app/tx/0x6964211185aca1ca77c5ca73d31c8da1011630b62198858c86a7026f52d69b3a) | 235653 |
| 6-receivable | setBudget | [0x6e4d7193...](https://testnet.arcscan.app/tx/0x6e4d719339b5055aaecb0b22cb25b054f091aa02cf3ffedc205f0552056ceb9f) | 43969 |
| 6-receivable | fund | [0x1e32f2ca...](https://testnet.arcscan.app/tx/0x1e32f2cabf762727a03be17b122fb0f80e5084db7b25b55e0558ad3af3084929) | 84263 |
| 6-receivable | submit | [0x73712ecd...](https://testnet.arcscan.app/tx/0x73712ecde0177ecaaab988e51f3a8e1fb1d3db4cb141f268c7cf8f161b8bcc83) | 136844 |
| 6-receivable | list | [0xa6ca59a5...](https://testnet.arcscan.app/tx/0xa6ca59a5873d19683f8e761aecb9d6708fa1536abab31493bbf27ca49fb3da04) | 130415 |
| 6-receivable | buy | [0x1ebff13c...](https://testnet.arcscan.app/tx/0x1ebff13c99b2d6b3af0a1693c7f589c9e9d7706515035fbb3894a794ca7fafac) | 107864 |
| 6-receivable | finalize (pays the buyer) | [0x72f9e969...](https://testnet.arcscan.app/tx/0x72f9e96946c0c2178500cfb94c660d236cad1f2f7ba3451a1428dfa5a982e374) | 338180 |
| adversarial | createJob with a non-whitelisted hook: reverted with ExpiryInPast|HookNotWhitelisted |  |  |
| adversarial | createJob with a non-whitelisted hook and a valid expiry: reverted with HookNotWhitelisted |  |  |
| adversarial | dispute by a stranger: reverted with NotSubmitted|OnlyClient |  |  |
| adversarial | vote by a non-arbiter: reverted with AlreadyDecided|NotAnArbiter |  |  |
| adversarial | double finalize: reverted with NotSubmitted |  |  |
| 3-expiry | claimRefund (anyone) | [0xf017c558...](https://testnet.arcscan.app/tx/0xf017c558a06ba78e1a2634705168e3349063d07807836ba20b4ab7a1d397476f) | 62214 |
| 3-expiry | withdraw (client) | [0xd9a6b69e...](https://testnet.arcscan.app/tx/0xd9a6b69e8f631842112b324d4ff17e1ac7b89ca4df1ad47e8fcca2ccf187eb88) | 59023 |

## Per path

| Path | Gas | USDC |
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

## Deployment

| Contract | Address |
|---|---|
| squareJob | [0x2570a1511a562020c4F20c7ce97229376fe6B500](https://testnet.arcscan.app/address/0x2570a1511a562020c4F20c7ce97229376fe6B500) |
| keeperEvaluator | [0x6c62D57Ba7665ABF29795ac0c6d0245A0Ee8921e](https://testnet.arcscan.app/address/0x6c62D57Ba7665ABF29795ac0c6d0245A0Ee8921e) |
| arbitration | [0xA10C2e9f927BcEb6FB677b446E8ac8a4dd6cea4E](https://testnet.arcscan.app/address/0xA10C2e9f927BcEb6FB677b446E8ac8a4dd6cea4E) |
| claimMarket | [0xc5495bc52f64C9Fa04c3906ca0d751D7bC3F56f3](https://testnet.arcscan.app/address/0xc5495bc52f64C9Fa04c3906ca0d751D7bC3F56f3) |
| squareHook | [0x92EC31aAdcD98Ba3528cfef67ec0690433c43E57](https://testnet.arcscan.app/address/0x92EC31aAdcD98Ba3528cfef67ec0690433c43E57) |
| usdc | [0x3600000000000000000000000000000000000000](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| identityRegistry | [0x8004A818BFB912233c491871b3d84c89A494BD9e](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| reputationRegistry | [0x8004B663056A597Dffe9eCcC1965A193B7388713](https://testnet.arcscan.app/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| validationRegistry | [0x8004Cb1BF31DAf7788923b405b754f57acEB4272](https://testnet.arcscan.app/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) |
