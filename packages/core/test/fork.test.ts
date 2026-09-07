import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { anvilAccount } from "./anvil.js";
import {
  createSquareClient,
  deploymentFromJson,
  eventsNamed,
  hashDeliverable,
  JobStatus,
  type SquareClient,
  type SquareDeployment,
} from "../src/index.js";

const forkUrl = process.env["ARC_FORK_RPC_URL"];

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet (fork)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [forkUrl ?? "http://127.0.0.1:8546"] } },
});

const identityRegistry = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const reputationRegistry = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;
const validationRegistry = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as const;
const smokeAgentId = 892271n;
const smokeAgentOwner = "0xa52c81e6aD0d73f001c911d906a907e5E36733A2" as const;
const deployerHd = anvilAccount(0);
const deployerKey = deployerHd.getHdKey().privateKey;

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

const reputationReadAbi = [
  { type: "function", name: "getLastIndex", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "readFeedback", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }, { type: "uint64" }], outputs: [{ type: "int128" }, { type: "uint8" }, { type: "string" }, { type: "string" }, { type: "bool" }] },
] as const;

const validationAbi = [
  { type: "function", name: "validationRequest", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "string" }, { type: "bytes32" }], outputs: [] },
  { type: "function", name: "getValidationStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "string" }, { type: "uint256" }] },
] as const;

const hookAdminAbi = [
  { type: "function", name: "setComplianceModule", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, "..", "..", "..", "contracts");
const deploymentFile = join(contractsDir, "deployments", "5042002.local.json");

describe.skipIf(!forkUrl)("lifecycle on an Arc Testnet fork with the real ERC-8004 registries", () => {
  const rpc = forkUrl ?? "";
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
  const testClient = createTestClient({ chain: arcTestnet, mode: "anvil", transport: http(rpc) });
  const deployer = deployerHd;
  const clientAccount = anvilAccount(1);
  const crankerAccount = anvilAccount(7);
  let deployment: SquareDeployment;
  let client: SquareClient;
  let provider: SquareClient;
  let cranker: SquareClient;
  const budget = parseUnits("25", 6);
  const requestHash = keccak256(stringToHex(`square-fork-validation-${Date.now()}`));

  async function impersonatedWallet(address: Address) {
    await testClient.impersonateAccount({ address });
    await testClient.setBalance({ address, value: parseEther("10") });
    return createWalletClient({ chain: arcTestnet, transport: http(rpc), account: address });
  }

  async function deployArtifact(name: string, wallet: ReturnType<typeof createWalletClient>): Promise<Address> {
    const artifact = JSON.parse(readFileSync(join(contractsDir, "out", `${name}.sol`, `${name}.json`), "utf8")) as {
      abi: readonly unknown[];
      bytecode: { object: Hex };
    };
    const hash = await wallet.deployContract({ abi: artifact.abi as never, bytecode: artifact.bytecode.object, chain: arcTestnet, account: wallet.account as never });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress as Address;
  }

  beforeAll(async () => {
    for (const account of [deployer, clientAccount, crankerAccount]) {
      await testClient.setBalance({ address: account.address, value: parseEther("100") });
    }
    const deployerWallet = createWalletClient({ chain: arcTestnet, transport: http(rpc), account: deployer });
    const escrowToken = await deployArtifact("MockUSDC3009", deployerWallet);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerWallet.writeContract({
        abi: mintAbi,
        address: escrowToken,
        functionName: "mint",
        args: [clientAccount.address, parseUnits("1000", 6)],
      }),
    });

    execSync("forge script script/DeploySettlement.s.sol --rpc-url " + rpc + " --broadcast", {
      cwd: contractsDir,
      stdio: "pipe",
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: `0x${Buffer.from(deployerKey ?? new Uint8Array()).toString("hex")}`,
        USDC_ADDRESS: escrowToken,
        IDENTITY_REGISTRY: identityRegistry,
        REPUTATION_REGISTRY: reputationRegistry,
        VALIDATION_REGISTRY: validationRegistry,
        PLATFORM_FEE_BP: "100",
        EVALUATOR_FEE_BP: "50",
        CHALLENGE_WINDOW: "3600",
        DISPUTE_WINDOW: "7200",
        ARBITERS: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
        ARBITER_THRESHOLD: "2",
        DEPLOYMENT_FILE: "deployments/5042002.local.json",
      },
    });
    deployment = deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8")));

    const providerWallet = await impersonatedWallet(smokeAgentOwner);
    await publicClient.waitForTransactionReceipt({
      hash: await providerWallet.writeContract({
        abi: validationAbi,
        address: validationRegistry,
        functionName: "validationRequest",
        args: [deployment.squareHook, smokeAgentId, "", requestHash],
      }),
    });

    const module = await deployArtifact("MockComplianceModule", deployerWallet);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerWallet.writeContract({
        abi: hookAdminAbi,
        address: deployment.squareHook,
        functionName: "setComplianceModule",
        args: [module],
      }),
    });

    client = createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: arcTestnet, transport: http(rpc), account: clientAccount }),
    });
    provider = createSquareClient({ publicClient, deployment, walletClient: providerWallet });
    cranker = createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: arcTestnet, transport: http(rpc), account: crankerAccount }),
    });
  }, 120_000);

  afterAll(() => {
    if (existsSync(deploymentFile)) rmSync(deploymentFile);
  });

  it("settles a job and writes reputation and validation to the real registries", async () => {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({
      provider: smokeAgentOwner,
      expiredAt: latest.timestamp + 30n * 24n * 3600n,
      spec: { task: "fork smoke", agent: smokeAgentId.toString() },
    });
    await provider.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    const deliverable = hashDeliverable("work delivered on the fork");
    await provider.submit({ jobId, deliverable, agentId: smokeAgentId, validationRequestHash: requestHash });
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Submitted);
    expect(await client.agentOf(jobId)).toBe(smokeAgentId);

    const end = await client.challengeEndsAt(jobId);
    const now = (await publicClient.getBlock()).timestamp;
    await testClient.increaseTime({ seconds: Number(BigInt(end) - now + 1n) });
    await testClient.mine({ blocks: 1 });

    const finalized = await cranker.finalize(jobId, "0x");
    const names = finalized.events.map((e) => `${e.contract}.${e.eventName}`);
    expect(names).toContain("SquareJob.JobCompleted");
    expect(names).toContain("SquareHook.ReputationRecorded");
    expect(names).toContain("SquareHook.ValidationRecorded");
    expect(names).not.toContain("SquareHook.ReputationWriteFailed");
    expect(names).not.toContain("SquareHook.ValidationWriteFailed");

    const lastIndex = await publicClient.readContract({
      abi: reputationReadAbi,
      address: reputationRegistry,
      functionName: "getLastIndex",
      args: [smokeAgentId, deployment.squareHook],
    });
    expect(lastIndex).toBe(1n);
    const [value, decimals, tag1, tag2, revoked] = await publicClient.readContract({
      abi: reputationReadAbi,
      address: reputationRegistry,
      functionName: "readFeedback",
      args: [smokeAgentId, deployment.squareHook, 1n],
    });
    expect(value).toBe(1n);
    expect(decimals).toBe(0);
    expect(tag1).toBe("square");
    expect(tag2).toBe("completed");
    expect(revoked).toBe(false);

    const [validator, agentId, response, , tag] = await publicClient.readContract({
      abi: validationAbi,
      address: validationRegistry,
      functionName: "getValidationStatus",
      args: [requestHash],
    });
    expect(validator).toBe(deployment.squareHook);
    expect(agentId).toBe(smokeAgentId);
    expect(response).toBe(100);
    expect(tag).toBe("square.compliance");

    const released = eventsNamed(finalized.events, "PaymentReleased")[0];
    expect(released?.args.provider).toBe(smokeAgentOwner);
    expect(await provider.withdrawable(smokeAgentOwner)).toBeGreaterThan(0n);
    await provider.withdraw();
    expect(await provider.usdcBalance(smokeAgentOwner)).toBeGreaterThan(0n);
  }, 120_000);
});
