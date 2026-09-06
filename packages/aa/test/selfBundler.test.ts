import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint06Address } from "viem/account-abstraction";
import { anvilAccount, forkChain, fundNative } from "../scripts/fork.js";
import {
  createJob,
  encodeSetBudget,
  encodeSubmit,
  fundJob,
  readJob,
  squareJobAbi,
  JobStatus,
  type Actor,
  type FeeOptions,
  type SquareEnv,
} from "../scripts/square.js";
import { simpleAccountAbi } from "../src/abi.js";
import { createSelfBundler, type SelfBundler } from "../src/selfBundler.js";
import {
  CallSimulationRevertedError,
  EntryPointMismatchError,
  UserOperationRejectedError,
} from "../src/errors.js";
import { toSimpleSmartAccount, type SimpleSmartAccount } from "../src/simpleAccount.js";

const rpcUrl = inject("rpcUrl");
const deployment = inject("deployment");

describe("an agent smart account accepts and submits a job through the self-bundler", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const keeperAccount = privateKeyToAccount(generatePrivateKey());
  const secondKeeperAccount = privateKeyToAccount(generatePrivateKey());
  const mallory = privateKeyToAccount(generatePrivateKey());
  const budget = parseUnits("250", 6);
  const deliverable = keccak256(toHex("deliverable:lifecycle"));

  let publicClient: PublicClient<Transport, Chain>;
  let client: Actor;
  let keeper: Actor;
  let secondKeeper: Actor;
  let env: SquareEnv;
  let bundler: SelfBundler;
  let account: SimpleSmartAccount;
  let fees: FeeOptions;
  let jobId: bigint;

  beforeAll(async () => {
    publicClient = createPublicClient({ chain: forkChain, transport: http(rpcUrl), pollingInterval: 50 });
    const wallet = (walletAccount: ReturnType<typeof privateKeyToAccount>): Actor =>
      createWalletClient({ chain: forkChain, transport: http(rpcUrl), account: walletAccount, pollingInterval: 50 });
    client = wallet(anvilAccount(1));
    keeper = wallet(keeperAccount);
    secondKeeper = wallet(secondKeeperAccount);
    await fundNative(rpcUrl, [client.account.address, keeper.account.address, secondKeeper.account.address]);
    env = { publicClient, deployment };
    bundler = createSelfBundler({ walletClient: keeper, publicClient });
    account = await toSimpleSmartAccount({ client: publicClient, owner, salt: 7n });
    const estimated = await publicClient.estimateFeesPerGas();
    fees = { maxFeePerGas: estimated.maxFeePerGas, maxPriorityFeePerGas: estimated.maxPriorityFeePerGas };
    jobId = await createJob(env, client, account.address);
  });

  it("the keeper is not the owner and the owner EOA holds nothing", async () => {
    expect(keeper.account.address).not.toBe(owner.address);
    expect(await publicClient.getBalance({ address: owner.address })).toBe(0n);
    expect(bundler.beneficiary).toBe(keeper.account.address);
    expect(bundler.entryPointAddress).toBe(account.entryPoint.address);
  });

  it("depositTo prefunds the account's EntryPoint deposit", async () => {
    expect(await bundler.getDeposit(account.address)).toBe(0n);
    const { receipt } = await bundler.depositTo(account.address, parseEther("1"));
    expect(receipt.status).toBe("success");
    expect(await bundler.getDeposit(account.address)).toBe(parseEther("1"));
  });

  it("the first UserOperation deploys the account and executes setBudget on the job", async () => {
    expect(await account.isDeployed()).toBe(false);
    const depositBefore = await bundler.getDeposit(account.address);

    const result = await bundler.sendUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSetBudget(jobId, budget) }],
      fees,
    );

    expect(result.success).toBe(true);
    expect(result.revertReason).toBeUndefined();
    expect(result.receipt.status).toBe("success");
    expect(result.actualGasUsed > 0n).toBe(true);
    expect(result.actualGasCost > 0n).toBe(true);
    expect(await publicClient.getCode({ address: account.address })).toBeDefined();
    expect(await account.isDeployed()).toBe(true);
    expect(
      await publicClient.readContract({ address: account.address, abi: simpleAccountAbi, functionName: "owner" }),
    ).toBe(owner.address);
    expect(await bundler.getDeposit(account.address)).toBe(depositBefore - result.actualGasCost);
    expect((await readJob(env, jobId)).budget).toBe(budget);
    expect(await account.getNonce()).toBe(1n);
  });

  it("after the client funds via the EOA path, a second UserOperation submits and the job is Submitted", async () => {
    await fundJob(env, client, jobId, budget);
    expect((await readJob(env, jobId)).status).toBe(JobStatus.Funded);

    const result = await bundler.sendUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSubmit(jobId, deliverable) }],
      fees,
    );

    expect(result.success).toBe(true);
    const record = await readJob(env, jobId);
    expect(record.status).toBe(JobStatus.Submitted);
    expect(record.deliverable).toBe(deliverable);
    expect(record.provider).toBe(account.address);
    expect(await account.getNonce()).toBe(2n);
  });

  it("any EOA can bundle: a second keeper that never met the owner submits a valid operation", async () => {
    const otherBundler = createSelfBundler({ walletClient: secondKeeper, publicClient });
    const secondJob = await createJob(env, client, account.address);
    const balanceBefore = await publicClient.getBalance({ address: secondKeeper.account.address });

    const result = await otherBundler.sendUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSetBudget(secondJob, budget) }],
      fees,
    );

    expect(result.success).toBe(true);
    expect((await readJob(env, secondJob)).budget).toBe(budget);
    const balanceAfter = await publicClient.getBalance({ address: secondKeeper.account.address });
    const paidForGas = result.receipt.gasUsed * result.receipt.effectiveGasPrice;
    expect(balanceAfter).toBe(balanceBefore - paidForGas + result.actualGasCost);
  });

  it("a UserOperation signed by a non-owner is rejected by the EntryPoint with AA24", async () => {
    const thirdJob = await createJob(env, client, account.address);
    const unsigned = await bundler.prepareUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSetBudget(thirdJob, budget) }],
      fees,
    );
    const forged = {
      ...unsigned,
      signature: await mallory.signMessage({ message: { raw: bundler.getUserOperationHash(unsigned) } }),
    };

    const attempt = bundler.submitUserOperation(forged);
    await expect(attempt).rejects.toBeInstanceOf(UserOperationRejectedError);
    await expect(attempt).rejects.toThrow(/AA24 signature error/);
    expect((await readJob(env, thirdJob)).budget).toBe(0n);
  });

  it("a stub signature is likewise rejected, so nothing about the stub is trusted on-chain", async () => {
    const stubJob = await createJob(env, client, account.address);
    const unsigned = await bundler.prepareUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSetBudget(stubJob, budget) }],
      fees,
    );
    await expect(bundler.submitUserOperation(unsigned)).rejects.toThrow(/AA24 signature error/);
  });

  it("refuses to prepare a call that reverts in simulation and exposes the decodable revert data", async () => {
    const openJob = await createJob(env, client, account.address);
    const attempt = bundler.prepareUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSubmit(openJob, deliverable) }],
      fees,
    );
    await expect(attempt).rejects.toBeInstanceOf(CallSimulationRevertedError);
    const error = await attempt.then(
      () => {
        throw new Error("expected the preparation to be refused");
      },
      (caught: unknown) => caught as CallSimulationRevertedError,
    );
    const decoded = decodeErrorResult({ abi: squareJobAbi, data: error.data as Hex });
    expect(decoded.errorName).toBe("WrongStatus");
    expect(await account.getNonce()).toBe(3n);
  });

  it("an included operation whose call reverts reports success=false with the revert data and still costs gas", async () => {
    const openJob = await createJob(env, client, account.address);
    const depositBefore = await bundler.getDeposit(account.address);

    const result = await bundler.sendUserOperation(
      account,
      [{ to: deployment.SquareJob, data: encodeSubmit(openJob, deliverable) }],
      { ...fees, callGasLimit: 150_000n },
    );

    expect(result.success).toBe(false);
    expect(result.receipt.status).toBe("success");
    expect(result.revertReason).toBeDefined();
    const decoded = decodeErrorResult({ abi: squareJobAbi, data: result.revertReason as Hex });
    expect(decoded.errorName).toBe("WrongStatus");
    expect((await readJob(env, openJob)).status).toBe(JobStatus.Open);
    expect(await bundler.getDeposit(account.address)).toBe(depositBefore - result.actualGasCost);
  });

  it("refuses an account that targets a different EntryPoint", async () => {
    const legacy = await toSimpleSmartAccount({
      client: publicClient,
      owner,
      salt: 7n,
      entryPointAddress: entryPoint06Address,
    });
    await expect(
      bundler.sendUserOperation(legacy, [{ to: deployment.SquareJob, data: encodeSetBudget(jobId, budget) }], fees),
    ).rejects.toBeInstanceOf(EntryPointMismatchError);
  });
});
