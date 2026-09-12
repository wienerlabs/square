import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  isAddressEqual,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
  type SmartAccount,
  type UserOperation,
} from "viem/account-abstraction";
import {
  estimateGas,
  readContract,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "viem/actions";
import { callGasLimitFromTransactionEstimate } from "./callGasLimit.js";
import { ENTRY_POINT_V07 } from "./constants.js";
import {
  CallSimulationRevertedError,
  EntryPointMismatchError,
  UserOperationEventNotFoundError,
  UserOperationRejectedError,
  isExecutionRevert,
  revertDataOf,
} from "./errors.js";
import { calcPreVerificationGas } from "./preVerificationGas.js";

export type SelfBundlerCall = {
  to: Address;
  data?: Hex | undefined;
  value?: bigint | undefined;
};

export type CreateSelfBundlerParameters = {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain | undefined>;
  entryPointAddress?: Address | undefined;
  beneficiary?: Address | undefined;
};

export type SendUserOperationOptions = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  callGasLimit?: bigint | undefined;
  verificationGasLimit?: bigint | undefined;
  preVerificationGas?: bigint | undefined;
  nonceKey?: bigint | undefined;
};

export type SendUserOperationResult = {
  txHash: Hash;
  userOpHash: Hash;
  success: boolean;
  actualGasUsed: bigint;
  actualGasCost: bigint;
  receipt: TransactionReceipt;
  revertReason?: Hex | undefined;
};

export type DepositResult = {
  txHash: Hash;
  receipt: TransactionReceipt;
};

export type UserOperationV07 = UserOperation<"0.7">;

export type SelfBundler = {
  entryPointAddress: Address;
  beneficiary: Address;
  chainId: number;
  prepareUserOperation(
    account: SmartAccount,
    calls: readonly SelfBundlerCall[],
    options: SendUserOperationOptions,
  ): Promise<UserOperationV07>;
  submitUserOperation(userOperation: UserOperationV07): Promise<SendUserOperationResult>;
  sendUserOperation(
    account: SmartAccount,
    calls: readonly SelfBundlerCall[],
    options: SendUserOperationOptions,
  ): Promise<SendUserOperationResult>;
  getUserOperationHash(userOperation: UserOperationV07): Hash;
  depositTo(account: Address, amount: bigint): Promise<DepositResult>;
  getDeposit(account: Address): Promise<bigint>;
};

export const DEFAULT_VERIFICATION_GAS_LIMIT = 150_000n;

export const DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT = 300_000n;

function toRejectedError(error: unknown): unknown {
  if (!(error instanceof ContractFunctionExecutionError)) return error;
  const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data) return error;
  const { errorName, args } = revert.data;
  if (errorName === "FailedOp" && args && args.length === 2) {
    return new UserOperationRejectedError({
      opIndex: args[0] as bigint,
      reason: String(args[1]),
      cause: error,
    });
  }
  if (errorName === "FailedOpWithRevert" && args && args.length === 3) {
    return new UserOperationRejectedError({
      opIndex: args[0] as bigint,
      reason: String(args[1]),
      inner: args[2] as Hex,
      cause: error,
    });
  }
  return error;
}

export function createSelfBundler(parameters: CreateSelfBundlerParameters): SelfBundler {
  const {
    walletClient,
    publicClient,
    entryPointAddress = ENTRY_POINT_V07,
    beneficiary = walletClient.account.address,
  } = parameters;
  const chainId = walletClient.chain.id;

  function assertCompatible(account: SmartAccount): void {
    const { address, version } = account.entryPoint;
    if (version !== "0.7" || !isAddressEqual(address, entryPointAddress)) {
      throw new EntryPointMismatchError(entryPointAddress, address, version);
    }
  }

  async function estimateCallGas(sender: Address, callData: Hex): Promise<bigint> {
    try {
      const estimate = await estimateGas(publicClient, {
        account: entryPointAddress,
        to: sender,
        data: callData,
      });
      return callGasLimitFromTransactionEstimate(estimate, callData);
    } catch (error) {
      if (!isExecutionRevert(error)) throw error;
      throw new CallSimulationRevertedError({ sender, callData, data: revertDataOf(error), cause: error as Error });
    }
  }

  function hashOf(userOperation: UserOperationV07): Hash {
    return getUserOperationHash({
      chainId,
      entryPointAddress,
      entryPointVersion: "0.7",
      userOperation,
    });
  }

  async function prepareUserOperation(
    account: SmartAccount,
    calls: readonly SelfBundlerCall[],
    options: SendUserOperationOptions,
  ): Promise<UserOperationV07> {
    assertCompatible(account);
    const sender = account.address;
    const [deployed, callData, nonce] = await Promise.all([
      account.isDeployed(),
      account.encodeCalls(calls),
      account.getNonce({ key: options.nonceKey ?? 0n }),
    ]);
    const factoryArgs = deployed ? {} : await account.getFactoryArgs();
    const request = {
      sender,
      nonce,
      callData,
      ...factoryArgs,
      maxFeePerGas: options.maxFeePerGas,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    };
    // The account's hint sees the fields the caller fixed, the way viem's
    // prepareUserOperation hands them over, and is not asked at all when
    // nothing is left open. toSimpleSmartAccount reads a fixed callGasLimit as
    // "do not simulate the call", which is what makes the documented way past
    // a simulated revert, pass callGasLimit explicitly, hold on the operation
    // that deploys the account and not only after it (#274): before, the hint
    // ran first and unconditionally, and on an undeployed account it threw on
    // the very revert the override was there to get past.
    const fixed = {
      ...(options.callGasLimit === undefined ? {} : { callGasLimit: options.callGasLimit }),
      ...(options.verificationGasLimit === undefined ? {} : { verificationGasLimit: options.verificationGasLimit }),
      ...(options.preVerificationGas === undefined ? {} : { preVerificationGas: options.preVerificationGas }),
    };
    const open =
      options.callGasLimit === undefined ||
      options.verificationGasLimit === undefined ||
      options.preVerificationGas === undefined;
    const hinted = open ? ((await account.userOperation?.estimateGas?.({ ...request, ...fixed })) ?? {}) : {};
    const callGasLimit =
      options.callGasLimit ??
      hinted.callGasLimit ??
      (deployed ? await estimateCallGas(sender, callData) : DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT);
    const verificationGasLimit =
      options.verificationGasLimit ?? hinted.verificationGasLimit ?? DEFAULT_VERIFICATION_GAS_LIMIT;
    const draft: UserOperationV07 = {
      ...request,
      callGasLimit,
      verificationGasLimit,
      preVerificationGas: 0n,
      signature: await account.getStubSignature(),
    };
    const preVerificationGas =
      options.preVerificationGas ??
      hinted.preVerificationGas ??
      calcPreVerificationGas(toPackedUserOperation(draft));
    return { ...draft, preVerificationGas };
  }

  async function submitUserOperation(userOperation: UserOperationV07): Promise<SendUserOperationResult> {
    const userOpHash = hashOf(userOperation);
    const packed = toPackedUserOperation(userOperation);
    let request;
    try {
      ({ request } = await simulateContract(publicClient, {
        account: walletClient.account,
        address: entryPointAddress,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[packed], beneficiary],
        maxFeePerGas: userOperation.maxFeePerGas,
        maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas,
      }));
    } catch (error) {
      throw toRejectedError(error);
    }
    const txHash = await writeContract(walletClient, { ...request, chain: walletClient.chain });
    const receipt = await waitForTransactionReceipt(publicClient, { hash: txHash });
    const fromEntryPoint = receipt.logs.filter((log) => isAddressEqual(log.address, entryPointAddress));
    const event = parseEventLogs({
      abi: entryPoint07Abi,
      eventName: "UserOperationEvent",
      logs: fromEntryPoint,
    }).find((candidate) => candidate.args.userOpHash === userOpHash);
    if (!event) throw new UserOperationEventNotFoundError(userOpHash, txHash);
    const reverted = parseEventLogs({
      abi: entryPoint07Abi,
      eventName: "UserOperationRevertReason",
      logs: fromEntryPoint,
    }).find((candidate) => candidate.args.userOpHash === userOpHash);
    return {
      txHash,
      userOpHash,
      success: event.args.success,
      actualGasUsed: event.args.actualGasUsed,
      actualGasCost: event.args.actualGasCost,
      receipt,
      ...(reverted ? { revertReason: reverted.args.revertReason } : {}),
    };
  }

  async function sendUserOperation(
    account: SmartAccount,
    calls: readonly SelfBundlerCall[],
    options: SendUserOperationOptions,
  ): Promise<SendUserOperationResult> {
    const unsigned = await prepareUserOperation(account, calls, options);
    const signature = await account.signUserOperation({ ...unsigned, chainId });
    return submitUserOperation({ ...unsigned, signature });
  }

  async function depositTo(account: Address, amount: bigint): Promise<DepositResult> {
    const txHash = await writeContract(walletClient, {
      address: entryPointAddress,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [account],
      value: amount,
    });
    const receipt = await waitForTransactionReceipt(publicClient, { hash: txHash });
    return { txHash, receipt };
  }

  async function getDeposit(account: Address): Promise<bigint> {
    return readContract(publicClient, {
      address: entryPointAddress,
      abi: entryPoint07Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }

  return {
    entryPointAddress,
    beneficiary,
    chainId,
    prepareUserOperation,
    submitUserOperation,
    sendUserOperation,
    getUserOperationHash: hashOf,
    depositTo,
    getDeposit,
  };
}
