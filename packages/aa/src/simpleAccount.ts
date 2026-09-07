import {
  BaseError,
  createNonceManager,
  decodeFunctionData,
  encodeFunctionData,
  pad,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedData,
  type TypedDataDefinition,
} from "viem";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toSmartAccount,
  type SmartAccount,
  type SmartAccountImplementation,
  type UserOperation,
} from "viem/account-abstraction";
import { estimateGas, getChainId, getCode, readContract } from "viem/actions";
import { simpleAccountAbi, simpleAccountFactoryAbi } from "./abi.js";
import { ENTRY_POINT_V07, SIMPLE_ACCOUNT_FACTORY_V07 } from "./constants.js";
import { CallSimulationRevertedError, isExecutionRevert, revertDataOf } from "./errors.js";

export type SimpleSmartAccountExtension = {
  abi: typeof simpleAccountAbi;
  owner: LocalAccount;
  salt: bigint;
  factoryAddress: Address;
};

export type SimpleSmartAccountImplementation = SmartAccountImplementation<
  typeof entryPoint07Abi,
  "0.7",
  SimpleSmartAccountExtension,
  false
>;

export type SimpleSmartAccount = SmartAccount<SimpleSmartAccountImplementation>;

export type ToSimpleSmartAccountParameters = {
  client: SmartAccountImplementation["client"];
  owner: LocalAccount;
  salt?: bigint | undefined;
  factoryAddress?: Address | undefined;
  entryPointAddress?: Address | undefined;
};

export const SIMPLE_ACCOUNT_STUB_SIGNATURE: Hex =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

export const SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT = 150_000n;

export const SIMPLE_ACCOUNT_PROXY_DISPATCH_GAS = 10_000n;

const OWNER_STORAGE_SLOT: Hex = toHex(0, { size: 32 });

export async function toSimpleSmartAccount(
  parameters: ToSimpleSmartAccountParameters,
): Promise<SimpleSmartAccount> {
  const {
    client,
    owner,
    salt = 0n,
    factoryAddress = SIMPLE_ACCOUNT_FACTORY_V07,
    entryPointAddress = ENTRY_POINT_V07,
  } = parameters;

  const chainId = client.chain?.id ?? (await getChainId(client));
  const factoryData = encodeFunctionData({
    abi: simpleAccountFactoryAbi,
    functionName: "createAccount",
    args: [owner.address, salt],
  });

  let counterfactual: Address | undefined;
  async function getAddress(): Promise<Address> {
    if (!counterfactual) {
      counterfactual = await readContract(client, {
        address: factoryAddress,
        abi: simpleAccountFactoryAbi,
        functionName: "getAddress",
        args: [owner.address, salt],
      });
    }
    return counterfactual;
  }

  async function estimateUndeployedCallGas(callData: Hex): Promise<bigint | undefined> {
    const sender = await getAddress();
    const implementation = await readContract(client, {
      address: factoryAddress,
      abi: simpleAccountFactoryAbi,
      functionName: "accountImplementation",
    });
    const code = await getCode(client, { address: implementation });
    if (!code) return undefined;
    try {
      const estimate = await estimateGas(client, {
        account: entryPointAddress,
        to: sender,
        data: callData,
        stateOverride: [
          {
            address: sender,
            code,
            stateDiff: [{ slot: OWNER_STORAGE_SLOT, value: pad(owner.address, { size: 32 }) }],
          },
        ],
      });
      return estimate + SIMPLE_ACCOUNT_PROXY_DISPATCH_GAS;
    } catch (error) {
      if (!isExecutionRevert(error)) return undefined;
      throw new CallSimulationRevertedError({ sender, callData, data: revertDataOf(error), cause: error as Error });
    }
  }

  const implementation: SimpleSmartAccountImplementation = {
    client,
    entryPoint: { abi: entryPoint07Abi, address: entryPointAddress, version: "0.7" },
    extend: { abi: simpleAccountAbi, owner, salt, factoryAddress },
    nonceKeyManager: createNonceManager({ source: { get: () => 0, set() {} } }),

    getAddress,

    async getFactoryArgs() {
      return { factory: factoryAddress, factoryData };
    },

    async encodeCalls(calls) {
      const [single] = calls;
      if (calls.length === 1 && single) {
        return encodeFunctionData({
          abi: simpleAccountAbi,
          functionName: "execute",
          args: [single.to, single.value ?? 0n, single.data ?? "0x"],
        });
      }
      return encodeFunctionData({
        abi: simpleAccountAbi,
        functionName: "executeBatch",
        args: [
          calls.map((call) => call.to),
          calls.map((call) => call.value ?? 0n),
          calls.map((call) => call.data ?? "0x"),
        ],
      });
    },

    async decodeCalls(data) {
      const decoded = decodeFunctionData({ abi: simpleAccountAbi, data });
      if (decoded.functionName === "execute") {
        const [to, value, callData] = decoded.args;
        return [{ to, value, data: callData }];
      }
      if (decoded.functionName === "executeBatch") {
        const [dest, value, func] = decoded.args;
        return dest.map((to, index) => ({ to, value: value[index] ?? 0n, data: func[index] ?? "0x" }));
      }
      throw new BaseError(`unable to decode calls for "${decoded.functionName}"`);
    },

    async getNonce(nonceParameters) {
      return readContract(client, {
        address: entryPointAddress,
        abi: entryPoint07Abi,
        functionName: "getNonce",
        args: [await getAddress(), nonceParameters?.key ?? 0n],
      });
    },

    async getStubSignature() {
      return SIMPLE_ACCOUNT_STUB_SIGNATURE;
    },

    async signMessage({ message }) {
      return owner.signMessage({ message });
    },

    async signTypedData(typedData) {
      return owner.signTypedData(typedData as TypedDataDefinition<TypedData, string>);
    },

    async signUserOperation(userOperationParameters) {
      const { chainId: signingChainId = chainId, ...userOperation } = userOperationParameters;
      const userOpHash = getUserOperationHash({
        chainId: signingChainId,
        entryPointAddress,
        entryPointVersion: "0.7",
        userOperation: {
          ...userOperation,
          sender: await getAddress(),
          signature: "0x",
        } as UserOperation<"0.7">,
      });
      return owner.signMessage({ message: { raw: userOpHash } });
    },

    userOperation: {
      async estimateGas(request) {
        if (!request.factory) {
          return { verificationGasLimit: SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT };
        }
        const creationGas = await estimateGas(client, { to: factoryAddress, data: factoryData });
        const callGasLimit = request.callData
          ? await estimateUndeployedCallGas(request.callData)
          : undefined;
        return {
          verificationGasLimit: creationGas + SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT,
          ...(callGasLimit === undefined ? {} : { callGasLimit }),
        };
      },
    },
  };

  return toSmartAccount(implementation);
}
