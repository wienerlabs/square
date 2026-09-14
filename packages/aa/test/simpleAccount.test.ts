import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  isErc6492Signature,
  keccak256,
  recoverMessageAddress,
  size,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { arcDeploymentFile, forkChain, forkDeploymentFile, parseDeployment } from "../scripts/fork.js";
import { encodeSubmit } from "../scripts/square.js";
import { simpleAccountAbi, simpleAccountFactoryAbi } from "../src/abi.js";
import { ENTRY_POINT_V07, SIMPLE_ACCOUNT_FACTORY_V07, SIMPLE_ACCOUNT_IMPLEMENTATION_V07 } from "../src/constants.js";
import { CallSimulationRevertedError } from "../src/errors.js";
import {
  toSimpleSmartAccount,
  SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT,
  type SimpleSmartAccount,
} from "../src/simpleAccount.js";
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

  it("the fork's record was removed once read, and the Arc Testnet record was not touched", () => {
    expect(existsSync(forkDeploymentFile)).toBe(false);
    expect(deployment.chainId).toBe(forkChain.id);
    // Same bytes as before the deploy, and not the fork's stack under the
    // real addresses' name: deploying to the fork used to overwrite this file
    // and the harness then deleted it (#270).
    const record = readFileSync(arcDeploymentFile, "utf8");
    expect(record).toBe(inject("arcDeploymentRecord"));
    expect(parseDeployment(JSON.parse(record)).SquareJob).not.toBe(deployment.SquareJob);
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

  // The hint is what viem's prepareUserOperation and the self-bundler consult
  // before estimating anything themselves, and both hand it the fields the
  // caller already fixed. What is fixed is not estimated, and for callGasLimit
  // that means not simulated: the simulation is where a reverting call is
  // refused, and a caller who fixed the limit has chosen to submit it (#274).
  it("the gas hint estimates only what the request leaves open, and does not simulate a call whose limit is fixed", async () => {
    const hint = account.userOperation?.estimateGas;
    expect(hint).toBeDefined();
    if (!hint) return;
    const { factory, factoryData } = await account.getFactoryArgs();
    // submit on a job that does not exist reverts, whatever else is on the fork.
    const reverting = await account.encodeCalls([
      { to: deployment.SquareJob, data: encodeSubmit(2n ** 200n, keccak256(toHex("deliverable:none"))) },
    ]);
    const undeployed = { sender: account.address, nonce: 0n, factory, factoryData, callData: reverting };

    await expect(hint(undeployed)).rejects.toBeInstanceOf(CallSimulationRevertedError);

    const partly = await hint({ ...undeployed, callGasLimit: 150_000n });
    expect(partly?.callGasLimit).toBeUndefined();
    expect(partly?.verificationGasLimit).toBeGreaterThan(SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT);

    expect(await hint({ ...undeployed, callGasLimit: 150_000n, verificationGasLimit: 400_000n })).toEqual({});

    const deployedForm = { sender: account.address, nonce: 0n, callData: reverting };
    expect(await hint(deployedForm)).toEqual({ verificationGasLimit: SIMPLE_ACCOUNT_VALIDATION_GAS_LIMIT });
    expect(await hint({ ...deployedForm, verificationGasLimit: 400_000n })).toEqual({});
  });

  it("signMessage delegates to the owner and viem wraps it in ERC-6492 while undeployed", async () => {
    const signature = await account.signMessage({ message: "square" });
    expect(isErc6492Signature(signature)).toBe(true);
    const ownerSignature = await owner.signMessage({ message: "square" });
    expect(signature.includes(ownerSignature.slice(2))).toBe(true);
  });
});
