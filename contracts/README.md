# Contracts

The settlement layer: an ERC-8183 job escrow on Arc, settled in the USDC ERC-20
interface, with an optimistic evaluator, bonded arbitration, a receivable market
and one whitelisted hook that routes payouts, runs the compliance check and
writes ERC-8004 reputation.

| Contract | Role | Design |
|---|---|---|
| `SquareJob` | ERC-8183 kernel: lifecycle, escrow, fee snapshot, pull-payment ledger, hook whitelist | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `KeeperEvaluator` | evaluator seat: challenge window, permissionless finalize, keeper fee, dispute entry | [keeper-economics.md](../docs/design/keeper-economics.md) |
| `Arbitration` | bonded disputes, versioned M-of-N arbiter set, bitmask votes, bond routing | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `ClaimMarket` | list, buy, cancel the receivable; `payeeOf` for the kernel | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `SquareHook` | the hook: agent binding, payout routing, compliance slot, reputation and validation writes | [square-hook.md](../docs/design/square-hook.md) |

## Commands

```bash
forge build
forge test
forge test --gas-report
```

Foundry 1.3 with `solc 0.8.28`, Cancun. Dependencies are git submodules under
`lib/` (`forge-std`, `openzeppelin-contracts` v5.7.0); clone with
`--recurse-submodules` or run `git submodule update --init`.

## Local stack

```bash
anvil --port 8545 --chain-id 31337
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`DeployLocal` deploys an EIP-3009 USDC mock and mock ERC-8004 registries, then
the five contracts wired the same way as on Arc, and writes
`deployments/31337.json`. Anvil's default accounts are the actors: 0 deploys and
owns, 1 is the client, 2 the provider (owner of mock agent 1), 3 the buyer,
4 to 6 the arbiters. `@squaresdk/core`'s anvil test runs the whole lifecycle
against it.

## Arc Testnet

```bash
set -a; source ~/.square/arc-testnet-deployer.env; set +a
export USDC_ADDRESS=0x3600000000000000000000000000000000000000
export IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
export REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
export VALIDATION_REGISTRY=0x8004Cb1BF31DAf7788923b405b754f57acEB4272
export ARBITERS=<addr>,<addr>,<addr> ARBITER_THRESHOLD=2
forge script script/Deploy.s.sol --rpc-url "$ARC_TESTNET_RPC_URL" --broadcast --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api
```

Every parameter is an environment variable with a documented default
(`script/Deploy.s.sol`); nothing is hard-coded. The script writes
`deployments/<chainId>.json`, which `@squaresdk/core` embeds. Ownership passes
to `OWNER` (a Safe) when it differs from the deployer; the deployer keeps nothing.

A dry run against a fork of the testnet with the real ERC-8004 registries is
`packages/core/test/fork.test.ts`. It escrows an EIP-3009 mock instead of the
real USDC because the ERC-20 interface at `0x3600...0000` moves native balances
through a system path anvil cannot execute; the reputation and validation writes
land on the deployed registry implementations and are read back from them.

```bash
anvil --port 8546 --chain-id 5042002 --fork-url https://rpc.testnet.arc.io
cd packages/core && ARC_FORK_RPC_URL=http://127.0.0.1:8546 npm test
```

## Measured gas

[docs/deploy/gas.md](../docs/deploy/gas.md).
