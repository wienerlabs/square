import { existsSync } from "node:fs";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  isErc6492Signature,
  recoverMessageAddress,
  size,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { deploymentFile, forkChain } from "../scripts/fork.js";
import { simpleAccountAbi, simpleAccountFactoryAbi } from "../src/abi.js";
import { ENTRY_POINT_V07, SIMPLE_ACCOUNT_FACTORY_V07, SIMPLE_ACCOUNT_IMPLEMENTATION_V07 } from "../src/constants.js";
import { toSimpleSmartAccount, type SimpleSmartAccount } from "../src/simpleAccount.js";
import type { UserOperationV07 } from "../src/selfBundler.js";

const rpcUrl = inject("rpcUrl");
const deployment = inject("deployment");

describe("toSimpleSmartAccount against the canonical v0.7 factory on the Arc fork", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const salt = 42n;
  let publicClient: PublicClient;
  let account: SimpleSmartAccount;

  beforeAll(async () => {
    publicClient = createPublicClient({ chain: forkChain, transport: http(rpcUrl), pollingInterval: 50 });
    account = await toSimpleSmartAccount({ client: publicClient, owner, salt });
  });

  it("the local deployment file was removed after the stack was read", () => {
    expect(existsSync(deploymentFile)).toBe(false);
    expect(deployment.chainId).toBe(forkChain.id);
  });

  it("the factory on Arc points at the v0.7 implementation bound to the v0.7 EntryPoint", async () => {
    const implementation = await publicClient.readContract({
      address: SIMPLE_ACCOUNT_FACTORY_V07,
      abi: simpleAccountFactoryAbi,
      functionName: "accountImplementation",
    });
    expect(implementation).toBe(SIMPLE_ACCOUNT_IMPLEMENTATION_V07);
    const entryPoint = await publicClient.readContract({
      address: implementation,
      abi: simpleAccountAbi,
      functionName: "entryPoint",
    });
    expect(entryPoint).toBe(ENTRY_POINT_V07);
  });

  it("computes the counterfactual address from factory.getAddress(owner, salt) and has no code", async () => {
    const expected = await publicClient.readContract({
      address: SIMPLE_ACCOUNT_FACTORY_V07,
      abi: simpleAccountFactoryAbi,
      functionName: "getAddress",
      args: [owner.address, salt],
    });
    expect(account.address).toBe(expected);
    expect(account.address).not.toBe(owner.address);
    expect(await publicClient.getCode({ address: account.address })).toBeUndefined();
    expect(await account.isDeployed()).toBe(false);
    expect(account.entryPoint).toEqual({ abi: entryPoint07Abi, address: ENTRY_POINT_V07, version: "0.7" });
  });

  it("exposes factory args that call createAccount(owner, salt)", async () => {
    const { factory, factoryData } = await account.getFactoryArgs();
    expect(factory).toBe(SIMPLE_ACCOUNT_FACTORY_V07);
    expect(factoryData).toBe(
      encodeFunctionData({ abi: simpleAccountFactoryAbi, functionName: "createAccount", args: [owner.address, salt] }),
    );
  });

  it("encodes one call as execute and several as executeBatch, and decodes both back", async () => {
    const target = deployment.SquareJob;
    const single = await account.encodeCalls([{ to: target, data: "0xdeadbeef", value: 5n }]);
    expect(decodeFunctionData({ abi: simpleAccountAbi, data: single })).toEqual({
      functionName: "execute",
      args: [target, 5n, "0xdeadbeef"],
    });
    expect(await account.decodeCalls?.(single)).toEqual([{ to: target, value: 5n, data: "0xdeadbeef" }]);

    const batch = await account.encodeCalls([
      { to: target, data: "0x01" },
      { to: deployment.USDC, data: "0x02", value: 1n },
    ]);
    expect(decodeFunctionData({ abi: simpleAccountAbi, data: batch })).toEqual({
      functionName: "executeBatch",
      args: [[target, deployment.USDC], [0n, 1n], ["0x01", "0x02"]],
    });
    expect(await account.decodeCalls?.(batch)).toEqual([
      { to: target, value: 0n, data: "0x01" },
      { to: deployment.USDC, value: 1n, data: "0x02" },
    ]);
  });

  it("starts at nonce zero under key zero and reflects the key in the upper 192 bits", async () => {
    expect(await account.getNonce()).toBe(0n);
    expect(await account.getNonce({ key: 1n })).toBe(1n << 64n);
  });

  it("returns a 65 byte stub signature", async () => {
    expect(size(await account.getStubSignature())).toBe(65);
  });

  it("signs the EntryPoint's own userOpHash with the owner key (personal_sign semantics)", async () => {
    const userOperation: UserOperationV07 = {
      sender: account.address,
      nonce: 0n,
      factory: SIMPLE_ACCOUNT_FACTORY_V07,
      factoryData: (await account.getFactoryArgs()).factoryData as Hex,
      callData: "0x",
      callGasLimit: 100_000n,
      verificationGasLimit: 400_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      signature: "0x",
    };
    const onChainHash = await publicClient.readContract({
      address: ENTRY_POINT_V07,
      abi: entryPoint07Abi,
      functionName: "getUserOpHash",
      args: [toPackedUserOperation(userOperation)],
    });
    const signature = await account.signUserOperation({ ...userOperation, chainId: forkChain.id });
    expect(size(signature)).toBe(65);
    expect(await recoverMessageAddress({ message: { raw: onChainHash }, signature })).toBe(owner.address);
  });

  it("signMessage delegates to the owner and viem wraps it in ERC-6492 while undeployed", async () => {
    const signature = await account.signMessage({ message: "square" });
    expect(isErc6492Signature(signature)).toBe(true);
    const ownerSignature = await owner.signMessage({ message: "square" });
    expect(signature.includes(ownerSignature.slice(2))).toBe(true);
  });
});
