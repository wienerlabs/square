import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseUnits, stringToHex, type Address } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, JobStatus, screeningRegistryAbi, squareHookAbi, squareJobAbi, type SquareDeployment } from "@squaresdk/core";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger } from "@squaresdk/observability";
import { Indexer } from "@squaresdk/indexer";
import { anvilAccount } from "./anvil.js";
import { Keeper } from "../src/run.js";
import { payeeScreening } from "../src/screening.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return ((await response.json()) as { result?: string }).result === "0x7a69";
  } catch {
    return false;
  }
}

function localDeployment(): { deployment: SquareDeployment; raw: Record<string, string> } {
  const file = join(here, "..", "..", "..", "contracts", "deployments", "31337.json");
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { deployment: deploymentFromJson(raw), raw };
  }
  return { deployment: deploymentFor(31337), raw: {} };
}

function artifact(name: string): { abi: unknown[]; bytecode: `0x${string}` } {
  const json = JSON.parse(readFileSync(join(here, "..", "..", "..", "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

// The EIP-712 type ScreeningRegistry verifies. Written out rather than imported:
// if it drifted from the contract's typehash, the registry would refuse every
// screening below and the test would say so.
const SCREENING_TYPES = {
  Screening: [
    { name: "subject", type: "address" },
    { name: "sanctioned", type: "bool" },
    { name: "screenedAt", type: "uint64" },
    { name: "source", type: "bytes32" },
    { name: "evidence", type: "bytes32" },
  ],
} as const;

const reachable = await anvilReachable();

// square#35, decision §4, on a real chain: the keeper holds a release whose
// payee nobody has freshly screened, finalizes it once someone has, and does not
// hold a payee a fresh screening says is designated. Its own hook and registry,
// so the other keeper suites running against the same anvil are not screened.
describe.skipIf(!reachable)("keeper and sanctions screening against anvil", () => {
  const { deployment } = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const silent = createLogger({ service: "test", version: "0", sink: () => {} });
  // anvil account 0 deployed the local stack and owns the kernel; it whitelists
  // this test's hook and funds its actors. The actors are keys drawn for the run,
  // so no other suite's transactions share their nonces.
  const owner = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(0) });
  const actor = () =>
    createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(generatePrivateKey()) }) });
  const client = actor();
  const provider = actor();
  // A second provider, so the two jobs have different payees: clearing one must
  // not release the other.
  const otherProvider = actor();
  const cranker = actor();
  const screener = privateKeyToAccount(generatePrivateKey());
  // Nothing listens here: the screener is down for the whole test.
  const deadScreener = "http://127.0.0.1:1";
  let db: Database;
  let hook: Address;
  let registry: Address;

  async function mined(hash: `0x${string}`): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
  }

  async function screen(subject: Address, sanctioned: boolean): Promise<void> {
    const screening = {
      subject,
      sanctioned,
      screenedAt: (await publicClient.getBlock()).timestamp,
      source: stringToHex("trm-sanctions-v1", { size: 32 }),
      evidence: keccak256(stringToHex(JSON.stringify([{ address: subject, isSanctioned: sanctioned }]))),
    };
    const signature = await screener.signTypedData({
      domain: { name: "Square Screening", version: "1", chainId: foundry.id, verifyingContract: registry },
      types: SCREENING_TYPES,
      primaryType: "Screening",
      message: screening,
    });
    await mined(await owner.writeContract({ address: registry, abi: screeningRegistryAbi, functionName: "submit", args: [screening, signature] }));
  }

  async function submittedOnOurHook(budget: bigint, by: ReturnType<typeof actor>): Promise<bigint> {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: by.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { screening: Date.now() }, hook });
    await by.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await by.submit({ jobId, deliverable: hashDeliverable(`screened ${jobId}`) });
    return jobId;
  }

  async function syncAll(): Promise<void> {
    const indexer = new Indexer({ db, publicClient, chainId: 31337, deployment, startBlock: 0n, batchBlocks: 500n, logger: silent });
    await indexer.start();
    while (true) {
      const result = await indexer.syncOnce();
      if (result === null || result.toBlock >= result.head) return;
    }
  }

  function keeperWith(screenerUrl: string): Keeper {
    return new Keeper({
      db,
      chainId: 31337,
      client: cranker,
      logger: silent,
      minimumMarginBps: 2000,
      defaultFinalizeGas: 450_000n,
      defaultFinalizeDecidedGas: 500_000n,
      recordExpiries: false,
      screenPayee: payeeScreening({ client: cranker, publicClient, screenerUrl }),
    });
  }

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
    const registryArtifact = artifact("ScreeningRegistry");
    registry = (await publicClient.waitForTransactionReceipt({
      hash: await owner.deployContract({ ...registryArtifact, args: [anvilAccount(0).address, 3600n] }),
    })).contractAddress as Address;
    const hookArtifact = artifact("SquareHook");
    hook = (await publicClient.waitForTransactionReceipt({
      hash: await owner.deployContract({
        ...hookArtifact,
        args: [
          deployment.squareJob, deployment.claimMarket, deployment.identityRegistry, deployment.reputationRegistry,
          deployment.validationRegistry, anvilAccount(0).address, deployment.keeperEvaluator, 1_000_000n,
        ],
      }),
    })).contractAddress as Address;
    await mined(await owner.writeContract({ address: deployment.squareJob, abi: squareJobAbi, functionName: "setHookWhitelist", args: [hook, true] }));
    await mined(await owner.writeContract({ address: hook, abi: squareHookAbi, functionName: "setScreening", args: [registry] }));
    await mined(await owner.writeContract({ address: registry, abi: screeningRegistryAbi, functionName: "setScreener", args: [screener.address, true] }));
    const usdc = artifact("MockUSDC");
    for (const account of [client.account, provider.account, otherProvider.account, cranker.account]) {
      await mined(await owner.sendTransaction({ to: account, value: 10n ** 18n }));
    }
    await mined(await owner.writeContract({ address: deployment.usdc, abi: usdc.abi, functionName: "mint", args: [client.account, parseUnits("1000", 6)] }));
  });

  afterAll(async () => {
    await db.close();
  });

  it("holds an unscreened payee, finalizes a cleared one, and lets a designated one be refused", async () => {
    await screen(client.account, false);
    await screen(provider.account, false);
    await screen(otherProvider.account, false);
    const first = await submittedOnOurHook(parseUnits("50", 6), provider);
    const second = await submittedOnOurHook(parseUnits("50", 6), otherProvider);
    const end = BigInt(await client.challengeEndsAt(second));
    const latest = await publicClient.getBlock();
    await testClient.increaseTime({ seconds: Number(end - latest.timestamp + 1n) });
    await testClient.mine({ blocks: 1 });
    await syncAll();

    // A day has passed: the funding-time screening is past its hour, and the
    // screener is down. The keeper holds both rather than have them refused.
    const held = await keeperWith(deadScreener).tick((await publicClient.getBlock()).timestamp);
    // The chain is shared, so the mirror also holds other suites' jobs; only
    // this test's two are asserted on.
    expect(held.finalized).not.toContain(first);
    expect(held.finalized).not.toContain(second);
    const unscreened = held.skipped.filter((s) => s.reason === "unscreened").map((s) => s.jobId);
    expect(unscreened).toContain(first);
    expect(unscreened).toContain(second);
    expect((await client.getJobRecord(first)).status).toBe(JobStatus.Submitted);

    // Someone screened the payee; the registry now clears it within its hour.
    await screen(provider.account, false);
    await syncAll();
    const netFirst = await cranker.netPayout(first);
    const providerBefore = await provider.withdrawable(provider.account);
    const cleared = await keeperWith(deadScreener).tick((await publicClient.getBlock()).timestamp);
    expect(cleared.finalized).toContain(first);
    expect((await provider.withdrawable(provider.account)) - providerBefore).toBe(netFirst);
    expect(cleared.skipped.filter((s) => s.reason === "unscreened").map((s) => s.jobId)).toContain(second);
    expect((await client.getJobRecord(second)).status).toBe(JobStatus.Submitted);

    // A fresh screening now says the payee is designated. Holding would only
    // delay the client's refund, so the keeper finalizes and the hook refuses.
    const fresh = await publicClient.getBlock();
    await testClient.increaseTime({ seconds: 1 });
    await testClient.mine({ blocks: 1 });
    expect((await publicClient.getBlock()).timestamp).toBeGreaterThan(fresh.timestamp);
    await screen(otherProvider.account, true);
    await syncAll();
    const clientBefore = await client.withdrawable(client.account);
    const refused = await keeperWith(deadScreener).tick((await publicClient.getBlock()).timestamp);
    expect(refused.finalized).toContain(second);
    expect(await otherProvider.withdrawable(otherProvider.account)).toBe(0n);
    expect((await client.withdrawable(client.account)) - clientBefore).toBe(await cranker.netPayout(second));
  }, 120_000);
});
