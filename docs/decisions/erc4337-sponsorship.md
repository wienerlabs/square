# Agents act through ERC-4337 accounts without a paymaster in phase 1

**Status:** decided in [#34][i34] by measurement. Builds on the keeper fee model
from [#21][i21]. Implemented by [`packages/aa`](../../packages/aa) (`@squaresdk/aa`).

[i21]: https://github.com/wienerlabs/square/issues/21
[i34]: https://github.com/wienerlabs/square/issues/34

## The question

On Arc the gas token is USDC, so an agent needs USDC before it can call `setBudget`
or `submit`. Account abstraction relaxes that: a keeper EOA can include the agent's
signed intent through `EntryPoint.handleOps`. The open question was whether the
keeper, the agent, or a third party must sponsor that gas. We measured instead of
guessing.

## Setup

- EntryPoint v0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and the canonical
  eth-infinitism SimpleAccountFactory v0.7 at `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985`,
  both already deployed on Arc testnet. v0.7 was chosen over v0.6 and v0.8 because
  the factory is there and viem's account-abstraction module targets v0.7 natively.
- No bundler and no paymaster. The keeper EOA calls `handleOps([op], keeper)` itself.
- Anvil fork of Arc testnet (block 60823359, chain id 5042002) with the Square stack
  deployed by `script/DeployLocal.s.sol`, so the real EntryPoint and factory answer.
- Gas price: every USDC figure below is at **20 gwei**, which is Arc testnet's
  base fee and a normalisation chosen for these rows, not the price the fork
  charged. The fork's six receipts in `packages/aa/measurements.json` carry
  2.550639404 down to 2.212450663 gwei, falling block by block because EIP-1559
  drains the base fee on an empty chain, on average 8.5 times under 20 gwei.
  Pricing the rows at the fork's own figure would describe the fork rather than
  Arc, so they are normalised to a realistic Arc base fee instead. At 20 gwei,
  1 gas = 2e-8 USDC and 100 000 gas = 0.002 USDC.

Three paths for each of the provider's two calls, `setBudget` and `submit`:
(a) a plain EOA transaction, (b) the same call as a UserOperation from an account
that already exists, (c) the first UserOperation, which also deploys the account.
Reproduce with `npm run measure` in `packages/aa`; the raw numbers are in
`packages/aa/measurements.json`.

**Base fee and gas price are two different numbers on Arc, and this repository
uses both.** 20 gwei is the base fee. About 22 gwei is the gas price, the base
fee plus the priority fee, and that is what a receipt reports as
`effectiveGasPrice`: the live measurement further down and
[docs/deploy/gas.md](../deploy/gas.md) are at 22.1728 gwei, the price the
2026-09-07 acceptance run's receipts carry. The fork table below is at the base
fee because it is a normalisation and not a receipt. Wherever this document, the
[AA package README](../../packages/aa/README.md) or the
[x402 decision record](./x402-facilitator.md) says 20 gwei it means the base
fee, and wherever one of them says about 22 gwei it means the gas price.

## Measurements

| Call | Path | Tx gas used | Cost at 20 gwei (USDC) | Overhead vs EOA (gas) | Overhead at 20 gwei (USDC) | Charged to the account (gas) |
|---|---|---:|---:|---:|---:|---:|
| `setBudget` | EOA | 43,969 | 0.00088 | 0 | 0 | n/a |
| `setBudget` | UserOp, account deployed | 102,678 | 0.00205 | 58,709 | 0.00117 | 106,944 |
| `setBudget` | UserOp, deploys the account | 273,066 | 0.00546 | 229,097 | 0.00458 | 277,823 |
| `submit` | EOA | 82,538 | 0.00165 | 0 | 0 | n/a |
| `submit` | UserOp, account deployed | 141,247 | 0.00282 | 58,709 | 0.00117 | 145,682 |
| `submit` | UserOp, deploys the account | 311,647 | 0.00623 | 229,109 | 0.00458 | 316,487 |

What the numbers say, with every USDC figure at the 20 gwei base fee:

- The steady-state cost of going through the EntryPoint is **58,709 gas per call,
  0.00117 USDC**, identical for both calls: it is EntryPoint bookkeeping plus the
  account's signature check and proxy dispatch, independent of the payload.
- Deploying the SimpleAccount proxy adds a one-time **170,400 gas, 0.0034 USDC**.
- The account, not the keeper, pays. `actualGasCost` is taken from the account's
  EntryPoint deposit and paid to the keeper as beneficiary. With the standard
  `preVerificationGas` formula the keeper came out **4,266 to 4,840 gas ahead** on
  every operation (the "charged" column minus the tx column), so relaying is not a
  subsidy even before any fee.
- A full job for the provider (`setBudget` + `submit`) costs 0.00253 USDC as an EOA,
  0.00488 USDC through an existing account, and 0.00829 USDC when the first call
  also deploys the account.

## Decision

1. **No paymaster in phase 1.** There is no bundler or paymaster on Arc testnet to
   integrate, and the cost a paymaster would cover is 0.001 to 0.006 USDC per call.
2. **The keeper does not need sponsorship.** It is reimbursed per operation from the
   account's deposit, and [#21][i21] forwards the evaluator fee (0.5% of the budget)
   to the keeper at finalization. On a 100 USDC job that is 0.50 USDC against
   0.0049 USDC of relayed gas. The fee covers both provider calls for any budget
   above about 1 USDC (1.7 USDC if the account is also deployed in that job).
3. **Agents prefund their own EntryPoint deposit once.** `depositTo(account, amount)`
   on the EntryPoint is the documented path; 0.1 USDC covers roughly 48 steady-state
   calls or 18 first calls including deployment. `@squaresdk/aa` exposes
   `bundler.depositTo` and `bundler.getDeposit` for this. Anyone may call `depositTo`
   for any account, so a keeper can seed an agent it wants to onboard and recover the
   amount from the first fee; that is a business decision, not protocol machinery.
4. **Sponsorship is only a question for agents that hold zero USDC**, and only until
   their first deposit. Revisit when onboarding such agents at scale: a verifying
   paymaster (Pimlico or Biconomy, once a bundler serves Arc) or Circle Wallets gas
   sponsorship. The account and bundler code do not change; `paymasterAndData` is
   already carried through packing and hashing.

## What follows from it

- Provider agents are `did:aip` identities whose wallet is a SimpleAccount; the job
  names the account as `provider`, and the account signs `setBudget` and `submit`.
- The self-bundler estimates `callGasLimit` from a simulation because EntryPoint
  v0.7 charges a 10% penalty on the execution gas an operation reserves and does
  not use. That penalty is what the estimate prevents; a generous constant would
  quietly inflate what the account pays. The estimate is a whole-transaction
  figure, so it also carries the 21,000 intrinsic and the calldata gas of the
  call, both of which `preVerificationGas` already charges once. Both are
  subtracted, and a 1.2 safety factor is applied to the execution gas that is
  left.
- The keeper submits with the same fee parameters as the operation, so the price
  the account is charged equals the price the keeper pays.

## What was considered and rejected

**A paymaster from day one.** Adds a trusted signer, a second deposit to manage and
an off-chain service, for a cost that the measurements put below a cent per job.

**Keeping agents on EOAs.** Halves the gas per call but forces every agent to be
funded before it can accept work and gives up batching and key rotation. The
absolute cost of the 4337 path (under 0.003 USDC per call) does not justify that.

**EntryPoint v0.6 or v0.8.** Both exist on Arc, but only v0.7 has the canonical
SimpleAccount factory deployed and first-class viem support.

## Verified on Arc Testnet

`npm run measure:live` ran on 2026-09-07 against the deployed stack (5042002), from block 60842683. All six receipts carry the same effective gas price, 22.1728 gwei, which is also what `actualGasCost / actualGasUsed` divides to exactly on each of the four UserOperation rows and what [`docs/deploy/gas.md`](../deploy/gas.md) records for the same acceptance run. The run set a fee cap of 26.1728 gwei; a cap is a ceiling and not a price, so it is kept in `measurements-5042002.json` as `maxFeePerGasWei` and no cost below is derived from it. The smart account accepted a real job with `setBudget` and submitted it, both through `EntryPoint.handleOps` sent by the keeper key; every row is a receipt on the chain.

| Call | Path | Gas used | Cost (USDC) | Overhead vs EOA | Transaction |
|---|---|---:|---:|---:|---|
| `setBudget` | EOA transaction | 43,969 | 0.00097 | 0 | [0x66ff5df3...](https://testnet.arcscan.app/tx/0x66ff5df384097c5149e799af581ee7c18091c9f511be3980920e7f4709991d27) |
| `submit` | EOA transaction | 82,538 | 0.00183 | 0 | [0xf29648fc...](https://testnet.arcscan.app/tx/0xf29648fc2c2415319d28d2af40d9be0945ad6011a6a4a948c3b8c86eb9bb0fc1) |
| `setBudget` | UserOperation, first op deploys the account | 273,054 | 0.00605 | 229,085 | [0x16240302...](https://testnet.arcscan.app/tx/0x16240302620308138e444eac74592c3de8806201d4305d65df278ab4660d4d48) |
| `submit` | UserOperation, account already deployed | 141,235 | 0.00313 | 58,697 | [0x9d971493...](https://testnet.arcscan.app/tx/0x9d971493ee9f19acb6ea5dfec7af41fc2cbdd50b7febb88cadef354a076756d0) |
| `setBudget` | UserOperation, account already deployed | 102,630 | 0.00228 | 58,661 | [0x0238ac11...](https://testnet.arcscan.app/tx/0x0238ac1177752c007b12513b82c290dd9093b0070faea603366340b713b3c1f4) |
| `submit` | UserOperation, first op deploys the account | 311,635 | 0.00691 | 229,097 | [0xa6fe3f12...](https://testnet.arcscan.app/tx/0xa6fe3f12ecc313d357f70574a8bae7c639008ce233612c4d1f1ff5fc9c44fdd2) |

The fork measurement above and the chain agree within a few dozen gas per row. The account deployment premium is 229 085 gas (about 0.005 USDC at this price), the steady-state premium 58 661 to 58 697 gas per operation, and the keeper stayed ahead on every operation.
