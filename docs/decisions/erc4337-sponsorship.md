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
- Gas price: 20 gwei, the base fee observed on Arc testnet and inherited by the fork.
  1 gas = 2e-8 USDC, 100 000 gas = 0.002 USDC.

Three paths for each of the provider's two calls, `setBudget` and `submit`:
(a) a plain EOA transaction, (b) the same call as a UserOperation from an account
that already exists, (c) the first UserOperation, which also deploys the account.
Reproduce with `npm run measure` in `packages/aa`; the raw numbers are in
`packages/aa/measurements.json`.

## Measurements

| Call | Path | Tx gas used | Cost (USDC) | Overhead vs EOA (gas) | Overhead (USDC) | Charged to the account (gas) |
|---|---|---:|---:|---:|---:|---:|
| `setBudget` | EOA | 43,969 | 0.00088 | 0 | 0 | n/a |
| `setBudget` | UserOp, account deployed | 102,678 | 0.00205 | 58,709 | 0.00117 | 106,944 |
| `setBudget` | UserOp, deploys the account | 273,066 | 0.00546 | 229,097 | 0.00458 | 277,823 |
| `submit` | EOA | 82,538 | 0.00165 | 0 | 0 | n/a |
| `submit` | UserOp, account deployed | 141,247 | 0.00282 | 58,709 | 0.00117 | 145,682 |
| `submit` | UserOp, deploys the account | 311,647 | 0.00623 | 229,109 | 0.00458 | 316,487 |

What the numbers say:

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
  v0.7 charges a 10% penalty on unused execution gas. A generous constant would
  quietly inflate what the account pays.
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
