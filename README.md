# Square

**Compliance-gated settlement for autonomous agent work, on [Arc](https://arc.io).**

An institution commits a private spending mandate on-chain. Identified agents execute
against it. Every release out of escrow must first prove, in zero knowledge, that it
fits the mandate. The receivable created during the challenge window is discountable.

---

## Status

**Pre-alpha.** One contract is on Arc testnet — the Groth16 verifier, at an
address the ceremony will replace. Everything else is unbuilt.

This repository is a ground-up rebuild on Arc (EVM, USDC-native gas), distilled from
three Solana codebases. No Rust ports here — the contract layer is written fresh in
Solidity against Arc's deployed standards.

> The ZK trusted setup inherited from the prior work is a **demo setup**, not a
> ceremony — in **both phases**. Phase 2 carries a single contribution and no
> beacon. Phase 1 was generated locally: the shipped verifying key carries an
> alpha and beta that match no published ceremony, so one machine held the tau.
> Either half on its own lets that machine forge a proof for any statement, so a
> ceremony covering both is planned. Until it completes, nothing here carries an
> assurance claim of any kind.
>
> The evidence, the wording, and where it has to appear:
> [docs/disclosure/](docs/disclosure/). Check it yourself with
> [`circuits/scripts/inspect-zkey-setup.mjs`](circuits/scripts/inspect-zkey-setup.mjs).

## Design

Three layers. Arc supplies the bottom one already.

| Layer | What we build | Arc primitive it sits on |
|---|---|---|
| Identity | `did:aip` v2 resolver, agent card schema | ERC-8004 `IdentityRegistry` |
| Settlement | `SquareJob` — optimistic challenge window, bonded disputes, M-of-N arbitration, receivable discounting | ERC-8183 `IACP` |
| Compliance | `ComplianceHook` — Groth16 proof gates the release | ERC-8183 `IACPHook` |

The composition point is the hook: the proof gates **release**, not deposit. Reputation
and validation outcomes are written to ERC-8004's `ReputationRegistry` and
`ValidationRegistry` rather than to a private ledger.

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
contracts/   Foundry — SquareJob, ComplianceHook, Groth16Verifier, PolicyRegistry,
             ClaimMarket, AipDidRegistry
circuits/    Circom payment-compliance circuit + ceremony scripts
packages/    did-resolver, core, agent, cli, mcp
services/    prover, indexer
app/         Next.js reference application
docs/        Specifications and design notes
```

## Network

| | |
|---|---|
| Chain | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Gas token | USDC (18 decimals native, 6 decimals ERC-20) |

Escrow and payment paths use the 6-decimal ERC-20 interface, not native value —
see [docs/decisions/erc20-vs-native-usdc.md](docs/decisions/erc20-vs-native-usdc.md).

### Deployments

| Contract | Address |
|---|---|
| `Groth16Verifier` | [`0x7b8E8089129094FD20a7C9243904343e4C6aBff7`](https://testnet.arcscan.app/address/0x7b8E8089129094FD20a7C9243904343e4C6aBff7) |

A proof from the prover service verifies against it on chain:

```console
$ node contracts/script/verify-on-arc.mjs --address 0x7b8E8089129094FD20a7C9243904343e4C6aBff7
  ok    compliant proof verifies
  ok    non-compliant proof also verifies — is_compliant is a signal, not a gate
  ok    flipped is_compliant
  ok    altered amount
```

Measured from transaction receipts: **262,403 gas** for a verification,
**486,154** to deploy — 0.0058 and 0.0108 USDC at current prices.

**The address is temporary.** The verifier is generated from a proving key and
is valid only for that key; today's is a development key, so
[#16](https://github.com/wienerlabs/square/issues/16) will produce a different
verifier at a different address. See
[contracts/README.md](contracts/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

Parts of the circuit, the prover and the client came from `wienerlabs/aperture`
and `dr-wilson-empty/aip-beta`, both MIT. [NOTICE](NOTICE) says which parts and
carries their copyright, as MIT requires. Nothing here derives from
`wienerlabs/covenant`, which is LGPL-2.1.
