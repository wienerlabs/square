# @squaresdk/aa

ERC-4337 account abstraction for Square agents on [Arc](https://arc.io). Two pieces,
both built on `viem/account-abstraction` and nothing else:

- `toSimpleSmartAccount` wraps the canonical eth-infinitism **SimpleAccount v0.7** as a
  viem `SmartAccount`, using the factory already deployed on Arc testnet.
- `createSelfBundler` turns any funded EOA (the keeper) into a bundler: it prepares,
  signs and submits a UserOperation through `EntryPoint.handleOps` itself. No bundler
  service, no paymaster.

Why this exists: gas on Arc is paid in USDC, so an agent whose EOA holds nothing cannot
call `setBudget` or `submit` on the Square kernel. With an account the agent only signs;
the keeper includes the operation and the account's EntryPoint deposit pays for it.
Whether anyone has to sponsor that gas was answered by measurement in
[`docs/decisions/erc4337-sponsorship.md`](../../docs/decisions/erc4337-sponsorship.md).

| | |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| SimpleAccountFactory v0.7 | `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985` |
| SimpleAccount implementation | `0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2` |
| Chain | Arc testnet, id `5042002` |

## Usage

```ts
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { createSelfBundler, toSimpleSmartAccount } from "@squaresdk/aa";

const rpc = http("https://rpc.testnet.arc.io");
const publicClient = createPublicClient({ chain: arcTestnet, transport: rpc });
const keeper = createWalletClient({ chain: arcTestnet, transport: rpc, account: privateKeyToAccount(keeperKey) });

const account = await toSimpleSmartAccount({ client: publicClient, owner: privateKeyToAccount(agentKey), salt: 0n });
const bundler = createSelfBundler({ walletClient: keeper, publicClient });

await bundler.depositTo(account.address, parseEther("0.1"));

const fees = await publicClient.estimateFeesPerGas();
const result = await bundler.sendUserOperation(account, [{ to: squareJob, data: setBudgetCalldata }], fees);
result.success;
result.txHash;
result.userOpHash;
result.actualGasCost;
```

`parseEther("0.1")` is 0.1 USDC: the native interface of Arc's gas token has 18 decimals,
the ERC-20 interface has 6. Deposits go through the native interface.

## The flow

1. **Counterfactual address.** `factory.getAddress(owner, salt)`; the account has no code
   until its first operation. `account.getFactoryArgs()` returns the factory and the
   `createAccount(owner, salt)` calldata the EntryPoint runs as `initCode`.
2. **Prefund.** `bundler.depositTo(account, amount)` calls `EntryPoint.depositTo{value}`.
   The deposit is what the EntryPoint charges; the owner EOA never needs a balance.
   Anyone may deposit for any account. `bundler.getDeposit(account)` reads it back.
3. **Prepare.** Nonce from `EntryPoint.getNonce(account, key)` (key 0 by default, so
   nonces are sequential; pass `nonceKey` for a parallel lane), factory args while the
   account is undeployed, `callData` as `execute(dest, value, func)` for one call or
   `executeBatch(dest[], value[], func[])` for several, gas limits as described below.
4. **Sign.** The owner signs the v0.7 `userOpHash` with `personal_sign`
   (`owner.signMessage({ message: { raw: hash } })`). SimpleAccount v0.7 accepts the
   operation when `owner == ECDSA.recover(userOpHash.toEthSignedMessageHash(), signature)`.
   The hash is computed locally and checked against `EntryPoint.getUserOpHash` in the tests.
5. **Submit.** The bundler simulates `handleOps([op], beneficiary)`, sends it from the
   keeper with the operation's own fee parameters, waits for the receipt and parses the
   EntryPoint's `UserOperationEvent`. `beneficiary` defaults to the keeper, so the
   `actualGasCost` taken from the account's deposit lands in the keeper's balance.

`sendUserOperation` is `prepareUserOperation` + `account.signUserOperation` +
`submitUserOperation`; the three are exported separately so an operation can be signed
elsewhere or inspected before it is sent.

The result carries `txHash`, `userOpHash`, `success`, `actualGasUsed`, `actualGasCost`,
the `receipt`, and `revertReason` when the operation was included but its call reverted
(the EntryPoint still charges the account for that; the reason is the raw revert data).

## Gas limits

EntryPoint v0.7 charges the account a 10% penalty on unused execution gas, so a generous
constant `callGasLimit` would quietly inflate what the account pays. The bundler estimates:

| Field | How |
|---|---|
| `callGasLimit` | `eth_estimateGas` of the call data from the EntryPoint address to the account. For an undeployed account, `toSimpleSmartAccount` simulates with a state override that places the implementation code and the owner slot at the counterfactual address, plus 10,000 gas for the proxy dispatch. If the RPC has no state overrides, 300,000. |
| `verificationGasLimit` | 150,000, plus the estimated `createAccount` gas when the operation deploys the account. Unused verification gas is not penalized. |
| `preVerificationGas` | The eth-infinitism bundler formula: 21,000 fixed + 18,300 per operation + calldata bytes at 4/16 gas + 4 per word. It keeps the keeper whole: measured 4,300 to 4,800 gas ahead per operation. |

Every field can be overridden per call. A call that reverts in simulation raises
`CallSimulationRevertedError` with the revert data instead of being included and paid
for; pass `callGasLimit` explicitly to submit it anyway.

## Signatures

- `signUserOperation`: `personal_sign` over the v0.7 user operation hash, as above.
- `signMessage` and `signTypedData` delegate to the owner. These have EOA signature
  semantics: SimpleAccount v0.7 does not implement ERC-1271, so a contract cannot verify
  them against the account address. While the account is undeployed viem wraps them in
  an ERC-6492 envelope, which is the standard way to say "verify against this factory".
- `getStubSignature` returns 65 dummy bytes for estimation only. The EntryPoint rejects
  it with `AA24 signature error`, and so it rejects any signature by a non-owner.

## Errors

| Error | When |
|---|---|
| `UserOperationRejectedError` | `handleOps` reverted with `FailedOp` or `FailedOpWithRevert`; `reason` is the AA code (`AA24 signature error`, `AA25 invalid account nonce`, `AA21 didn't pay prefund`, ...). |
| `CallSimulationRevertedError` | The call would revert; `data` holds the revert data for `decodeErrorResult`. |
| `EntryPointMismatchError` | The account targets another EntryPoint or version than the bundler. |
| `UserOperationEventNotFoundError` | The transaction mined without the event for this operation. |

## Tests

```bash
npm test
```

The suite forks Arc testnet with anvil on port 8561, so the real EntryPoint and factory
answer, funds its actors with `anvil_setBalance`, deploys the Square stack on the fork
and runs three suites. It needs `anvil`, `forge`, the contracts compiled in
`contracts/out`, and network access to `https://rpc.testnet.arc.io`.

The stack is deployed with `forge script script/DeployLocal.s.sol --broadcast --slow`
against the fork (`--slow` because anvil left the rest of a broadcast burst queued after
the first two transactions). That script writes `contracts/deployments/5042002.json`.
**The harness reads the file and deletes it immediately**, together with
`contracts/broadcast/DeployLocal.s.sol/5042002`, because that path is where the real Arc
testnet deployment will live and a fork's addresses must never be mistaken for it. The
first test asserts the file is gone. Set `AA_DEPLOY_FROM_ARTIFACTS=1` to deploy from the
compiled artifacts in `contracts/out` through viem instead: no forge process and nothing
written under `contracts/`, useful when the contracts tree does not compile.

What is covered:

- the counterfactual address equals `factory.getAddress(owner, salt)` and has no code;
- `execute` and `executeBatch` encoding, and decoding back;
- the local user operation hash equals `EntryPoint.getUserOpHash` and the signature
  recovers to the owner;
- the first operation deploys the account and executes `setBudget` on a job the client
  created naming the account as provider; the client funds through the EOA path; a second
  operation submits and the job reaches status 2 (Submitted);
- a keeper that never met the owner bundles a valid operation and is reimbursed;
- a non-owner signature and the stub signature are rejected with `AA24`;
- a reverting call is refused in simulation with decodable revert data, and when forced
  through it is included with `success = false` and still charged to the deposit;
- the measurement below runs, every figure is positive, and `measurements.json` is written.

## Measurement

```bash
npm run measure
```

Starts its own fork on port 8562, deploys the stack, drives the provider's `setBudget` and
`submit` as (a) EOA transactions, (b) UserOperations from a deployed account and (c) a
first UserOperation that also deploys the account, prints the table and writes
`measurements.json`. Cost is at 20 gwei, the base fee observed on Arc testnet
(1 gas = 2e-8 USDC). Rerunning moves the figures by a few dozen gas because the
calldata bytes (addresses, nonces) change.

| Call | Path | Tx gas used | Cost at 20 gwei (USDC) | Overhead vs EOA (gas) | Overhead (USDC) | Charged to account (gas) | Keeper net (USDC) |
|---|---|---:|---:|---:|---:|---:|---:|
| `setBudget` | EOA transaction | 43,969 | 0.00087938 | 0 | 0 | n/a | n/a |
| `setBudget` | UserOperation, account already deployed | 102,678 | 0.00205356 | 58,709 | 0.00117418 | 106,944 | 0.000009644343408648 |
| `setBudget` | UserOperation, first op deploys the account | 273,066 | 0.00546132 | 229,097 | 0.00458194 | 277,823 | 0.000011146222824699 |
| `submit` | EOA transaction | 82,538 | 0.00165076 | 0 | 0 | n/a | n/a |
| `submit` | UserOperation, account already deployed | 141,247 | 0.00282494 | 58,709 | 0.00117418 | 145,682 | 0.000010144314364285 |
| `submit` | UserOperation, first op deploys the account | 311,647 | 0.00623294 | 229,109 | 0.00458218 | 316,487 | 0.00001070826120892 |

"Keeper net" is `actualGasCost` received minus the gas the keeper paid, at the fork's
effective gas price; positive means the keeper was made whole with a margin. The
conclusion drawn from these numbers, no paymaster in phase 1 and a one-time deposit per
agent, is in the decision document linked above.
