<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/logo-inverse.svg">
    <img src="app/public/logo.svg" alt="Square" width="96" height="96">
  </picture>
</p>

<h1 align="center">Square</h1>

<p align="center"><strong>Compliance-gated settlement for autonomous agent work, on <a href="https://arc.io">Arc</a>.</strong></p>

<p align="center">
  <a href="https://www.arc.io"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/arc-logo-white.svg">
    <img src="app/public/brand/arc-logo-black.svg" alt="Built on Arc" height="50">
  </picture></a>
</p>

An institution commits a private spending mandate on-chain. Identified agents execute
against it. Every release out of escrow must first prove, in zero knowledge, that it
fits the mandate. The receivable created during the challenge window is discountable.

---

## Status

**Pre-alpha on Arc Testnet.** The settlement layer and the Groth16 verifier are
deployed on the testnet; the verifier sits at an address the ceremony will
replace. Nothing carries an assurance claim.

| Layer | State |
|---|---|
| Identity: `did:aip` v2, agent card, CLI, Universal Resolver driver | live against ERC-8004 on Arc Testnet ([docs/smoke](docs/smoke/)) |
| Settlement: `SquareJob`, `KeeperEvaluator`, `Arbitration`, `ClaimMarket`, `SquareHook` | deployed on Arc Testnet, 127 Foundry tests including a bond-solvency invariant suite, the five settlement paths run on the testnet with real USDC and the deployed ERC-8004 registries ([docs/deploy/lifecycle-5042002.md](docs/deploy/lifecycle-5042002.md)) |
| Services: indexer, keeper, x402 gateway, data layer, observability | implemented and tested against the local stack |
| Compliance: circuit, prover, Groth16 verifier, `ComplianceHook` | circuit, prover and verifier live (#14, #18, #17); the hook slot is open (#27) |
| Website (`site/`) | live at [square-protocol.vercel.app](https://square-protocol.vercel.app), adapted from an MIT template with Square's own copy and surfaces, every button leads to the app |
| App: reference web application (`app/`) | live at [square-wienerlabs.vercel.app](https://square-wienerlabs.vercel.app), a static Next.js export that reads the deployed contracts through `@squaresdk/core` and drives every lifecycle action from a connected wallet; no mocked data ([app/README.md](app/README.md)) |

> The ZK trusted setup inherited from the prior work is a **demo setup**, not a
> ceremony, in **both phases**: phase 2 carries a single contribution and no
> beacon, and phase 1 was generated locally. Either half on its own lets that
> machine forge a proof for any statement, so a ceremony covering both is
> planned. Until it completes, nothing here carries an assurance claim of any
> kind. Evidence and wording: [docs/disclosure/](docs/disclosure/), check it with
> [`circuits/scripts/inspect-zkey-setup.mjs`](circuits/scripts/inspect-zkey-setup.mjs).

## Design

Three layers. Arc supplies the bottom one already.

| Layer | What we build | Arc primitive it sits on |
|---|---|---|
| Identity | `did:aip` v2 resolver, agent card schema | ERC-8004 `IdentityRegistry` |
| Settlement | `SquareJob` (ERC-8183 kernel, pull-payment ledger), `KeeperEvaluator` (optimistic challenge window, paid permissionless finalize), `Arbitration` (bonded disputes, M-of-N), `ClaimMarket` (receivable discounting) | ERC-8183 `IACP` |
| Compliance | `SquareHook` routes the payout, runs the Groth16 proof check and writes reputation; `ComplianceHook` plugs into its slot | ERC-8183 `IACPHook`, ERC-8004 `ReputationRegistry` and `ValidationRegistry` |

The composition point is the hook: the proof gates **release**, not deposit,
and it is bound to the address the kernel will actually pay, which is the
receivable's buyer when the receivable was sold. Reputation stays with the agent
that did the work.

Design notes, each the record of a decision:

- [Storage layout and event schema](docs/design/storage-and-events.md)
- [SquareHook: one hook, selector routing, shared optParams](docs/design/square-hook.md)
- [Data layer: one Postgres, chain is the source of truth](docs/design/data-layer.md)
- [Keeper economics: why the crank is paid](docs/design/keeper-economics.md)
- [ERC-20 versus native USDC](docs/decisions/erc20-vs-native-usdc.md)
- [x402: own facilitator versus Circle Gateway](docs/decisions/x402-facilitator.md)
- [ERC-4337: is sponsorship needed](docs/decisions/erc4337-sponsorship.md)
- [Gas, measured](docs/deploy/gas.md)

## Provenance

Distilled from three prior repositories. Selected components only; the on-chain layer
is not ported.

| Source | What carries over |
|---|---|
| [aperture](https://github.com/wienerlabs/aperture) | Circom circuit, Poseidon policy commitment, prover service |
| [aip-beta](https://github.com/dr-wilson-empty/aip-beta) | `did:aip` spec and resolver, A2A task protocol, MCP bridge, agent SDK |
| [covenant](https://github.com/wienerlabs/covenant) | Escrow state machine (as specification), x402 verifier, chain-agnostic hardening |

## Layout

```
contracts/   Foundry: SquareJob, KeeperEvaluator, Arbitration, ClaimMarket, SquareHook,
             deploy scripts, 102 tests
circuits/    Circom payment-compliance circuit + ceremony scripts
packages/    did-resolver, cli, did-aip-driver, core (SDK, embedded ABIs), data (Postgres
             access layer + migrations), hardening (SSRF, idempotency, rate limit, RPC
             failover, signed actions), observability (logs, metrics, health, alerts),
             x402 (payment gateway), aa (ERC-4337 smart accounts)
services/    prover, indexer, keeper
app/         Next.js reference application (static export, wagmi, Open Runde design system)
site/        The website at https://square-protocol.vercel.app: what Square is, and the door to the app
docs/        Specifications, design notes, measurements, disclosure
```

## Network

| | |
|---|---|
| Chain | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Gas token | USDC (18 decimals native, 6 decimals ERC-20 at `0x3600000000000000000000000000000000000000`) |
| ERC-8004 | Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`, Validation `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| ERC-4337 | EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, SimpleAccountFactory `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985` |

Escrow and payment paths use the 6-decimal ERC-20 interface, not native value:
[docs/decisions/erc20-vs-native-usdc.md](docs/decisions/erc20-vs-native-usdc.md).

### Deployments

| Contract | Address |
|---|---|
| `Groth16Verifier` | [`0x35d7B65BDDf5C19DE107B1f90110B1FB381F7Ae1`](https://testnet.arcscan.app/address/0x35d7B65BDDf5C19DE107B1f90110B1FB381F7Ae1) |

A proof from the prover service verifies against it on chain:

```console
$ node contracts/script/verify-on-arc.mjs --address 0x35d7B65BDDf5C19DE107B1f90110B1FB381F7Ae1
  ok    compliant proof verifies
  ok    non-compliant proof also verifies, is_compliant is a signal, not a gate
  ok    flipped is_compliant
  ok    altered amount
```

Measured on Arc: **281,596 gas** for a whole verification call and
**714,837** to deploy, 0.0062 and 0.0158 USDC at 22 gwei. The verifier is
written here under Apache-2.0 from the pairing equation, not generated by
snarkjs; the previous generated deployment at `0x7b8E8089129094FD20a7C9243904343e4C6aBff7` is superseded
([docs/decisions/groth16-verifier-license.md](docs/decisions/groth16-verifier-license.md)).

**The verifier address is temporary.** It is generated from a proving key and
is valid only for that key; today's is a development key, so
[#16](https://github.com/wienerlabs/square/issues/16) will produce a different
verifier at a different address. See
[contracts/README.md](contracts/README.md).

### Square contracts

Deployed on 2026-09-07 from `0xaFF9CD31ae93e1bdD70FFDf0763C2e010037c65c` with
`contracts/script/DeploySettlement.s.sol`. Testnet parameters: challenge window
120 s, dispute window 300 s, evaluator fee 0.5 %, platform fee 1 %, bond 10 %
with a 1 USDC floor, three arbiters with threshold 2. The owner is still the
deployer; a Safe takes over before mainnet.

| Contract | Address |
|---|---|
| `SquareJob` | [`0x32E642084dbE5C5673d7A7E5F69b6A8260e4f3da`](https://testnet.arcscan.app/address/0x32E642084dbE5C5673d7A7E5F69b6A8260e4f3da) |
| `KeeperEvaluator` | [`0xD9f9137fC9B316b92762792Ad64760B4C5dD29C3`](https://testnet.arcscan.app/address/0xD9f9137fC9B316b92762792Ad64760B4C5dD29C3) |
| `Arbitration` | [`0x0Ad6268d7e420Bd7c2BDBb6e1078b99CDf5c07cC`](https://testnet.arcscan.app/address/0x0Ad6268d7e420Bd7c2BDBb6e1078b99CDf5c07cC) |
| `ClaimMarket` | [`0x32eD0Ef1AD401DD6E622775283624438716730c0`](https://testnet.arcscan.app/address/0x32eD0Ef1AD401DD6E622775283624438716730c0) |
| `SquareHook` | [`0xE61f869806Ca6121d33Ed2c9441a5449cF249198`](https://testnet.arcscan.app/address/0xE61f869806Ca6121d33Ed2c9441a5449cF249198) |

`@squaresdk/core` carries these addresses (`deployments[5042002]`). The five
settlement paths were run against them with real USDC and a provider registered
as ERC-8004 agent `892531`; every transaction hash and the measured gas are in
[docs/deploy/lifecycle-5042002.md](docs/deploy/lifecycle-5042002.md).

## License

Apache-2.0. See [LICENSE](LICENSE). [NOTICE](NOTICE) carries the MIT notices
of the code that came from the prior repositories.

Parts of the circuit, the prover and the client came from `wienerlabs/aperture`
and `dr-wilson-empty/aip-beta`, both MIT; NOTICE says which parts and carries
their copyright, as MIT requires.

Nothing here derives from `wienerlabs/covenant`, which is LGPL-2.1.

Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates. Square is built on Arc and is not affiliated with or endorsed by Circle.
