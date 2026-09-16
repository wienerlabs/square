import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Address } from "viem";
import { foundry } from "viem/chains";
import { anvilAccount } from "./anvil.js";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { keeperJobState, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger, createMetrics } from "@squaresdk/observability";
import { Indexer } from "@squaresdk/indexer";
import { minimumProfitableBudget } from "../src/decide.js";
import { finalizeGasDefaults, GATED_FINALIZE_GAS, MODULELESS_FINALIZE_GAS } from "../src/gas.js";
import { Keeper } from "../src/run.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const BASE_FEE = 17_000_000_000n;
const MARGIN_BPS = 2_000;
const FEE_BP = 50;
const GRACE = 3_600n;
const SMALL = parseUnits("3", 6);
const LARGE = parseUnits("6", 6);

function localDeployment(): SquareDeployment {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "..", "..", "contracts", "deployments", "31337.json");
  if (existsSync(file)) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(31337);
}

async function moduleOnTheHook(): Promise<{ reachable: boolean; module: Address | null }> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (((await response.json()) as { result?: string }).result !== "0x7a69") return { reachable: false, module: null };
  } catch {
    return { reachable: false, module: null };
  }
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const reader = createSquareClient({ publicClient, deployment: localDeployment() });
  return { reachable: true, module: await reader.complianceModule() };
}

const { reachable, module } = await moduleOnTheHook();

describe.skipIf(!reachable)("the keeper's economics against the module the hook actually holds", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const silent = createLogger({ service: "test", version: "0", sink: () => {} });
  const actor = (index: number) =>
    createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(index) }),
    });
  const client = actor(1);
  const provider = actor(2);
  const cranker = actor(8);
  let db: Database;

  async function submitted(budget: bigint): Promise<bigint> {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { gated: Date.now() } });
    await provider.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await provider.submit({ jobId, deliverable: hashDeliverable(`gated ${jobId}`), agentId: 1n });
    return jobId;
  }

  async function closeTheWindow(jobId: bigint): Promise<void> {
    const end = await client.challengeEndsAt(jobId);
    const latest = await publicClient.getBlock();
    const ahead = BigInt(end) - latest.timestamp + 1n;
    if (ahead > 0n) await testClient.increaseTime({ seconds: Number(ahead) });
    await testClient.mine({ blocks: 1 });
  }

  async function pinTheGasPrice(): Promise<bigint> {
    await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: BASE_FEE });
    await testClient.mine({ blocks: 1 });
    return publicClient.getGasPrice();
  }

  async function syncAll(): Promise<void> {
    const indexer = new Indexer({ db, publicClient, chainId: 31337, deployment, startBlock: 0n, batchBlocks: 500n, logger: silent });
    await indexer.start();
    while (true) {
      const result = await indexer.syncOnce();
      if (result === null || result.toBlock >= result.head) return;
    }
  }

  function keeperOver(gas: bigint, grace: bigint, metrics = createMetrics({ service: "test", defaultMetrics: false })) {
    const defaults = finalizeGasDefaults(module !== null);
    const keeper = new Keeper({
      db,
      chainId: 31337,
      client: cranker,
      logger: silent,
      metrics,
      minimumMarginBps: MARGIN_BPS,
      defaultFinalizeGas: gas,
      defaultFinalizeDecidedGas: defaults.finalizeDecidedGas,
      complianceModule: module,
      proofGraceSeconds: grace,
      recordExpiries: false,
    });
    return { keeper, metrics };
  }

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
  });

  afterAll(async () => {
    await db.close();
  });

  it.skipIf(module === null)("skips a 3 USDC job as unprofitable and takes a 6 USDC one, at the gas a gated finalize really costs", async () => {
    const small = await submitted(SMALL);
    const large = await submitted(LARGE);
    await closeTheWindow(large);
    await syncAll();
    const gasPriceWei = await pinTheGasPrice();

    const threshold = minimumProfitableBudget(FEE_BP, gasPriceWei, GATED_FINALIZE_GAS, MARGIN_BPS);
    const wouldHaveBeen = minimumProfitableBudget(FEE_BP, gasPriceWei, MODULELESS_FINALIZE_GAS, MARGIN_BPS);
    expect(threshold).not.toBeNull();
    expect(threshold as bigint).toBeGreaterThan(SMALL);
    expect(threshold as bigint).toBeLessThan(LARGE);
    expect(wouldHaveBeen as bigint).toBeLessThan(SMALL);

    const { keeper, metrics } = keeperOver(GATED_FINALIZE_GAS, 0n);
    const report = await keeper.tick((await publicClient.getBlock()).timestamp);

    expect(report.skipped.find((entry) => entry.jobId === small)?.reason).toBe("unprofitable");
    expect(report.finalized).toContain(large);
    expect((await client.getJobRecord(small)).status).toBe(JobStatus.Submitted);
    expect((await client.getJobRecord(large)).status).toBe(JobStatus.Completed);

    expect(metrics.snapshot().finalizeGasUsed).toBeGreaterThan(400_000);
    expect(metrics.snapshot().releaseRefusals).toBe(1);
    expect(metrics.snapshot().releaseRefusalsWithAmount).toBe(1);
  }, 180_000);

  it.skipIf(module === null)("holds a job with no proof bound and never cranks it, because the evaluator refuses to settle one", async () => {
    const jobId = await submitted(parseUnits("50", 6));
    await closeTheWindow(jobId);
    await syncAll();
    await pinTheGasPrice();
    expect(await cranker.complianceProofOf(jobId)).toBe("0x");
    expect(await client.proofState(jobId)).toBe("missing");

    const { keeper } = keeperOver(GATED_FINALIZE_GAS, GRACE);
    const now = (await publicClient.getBlock()).timestamp;

    const first = await keeper.tick(now);
    expect(first.held).toContainEqual({ jobId, reason: "noProof" });
    expect(first.finalized).not.toContain(jobId);
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Submitted);
    expect((await keeperJobState.get(db, 31337, jobId))?.heldReason).toBe("noProof");

    const past = await keeper.tick(now + GRACE * 10n);
    expect(past.finalized).not.toContain(jobId);
    expect(past.held).toContainEqual({ jobId, reason: "noProof" });
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Submitted);
    expect((await keeperJobState.get(db, 31337, jobId))?.heldReason).toBe("noProof");

    await expect(cranker.finalize(jobId)).rejects.toThrow(/ProofRequired/);
  }, 180_000);

  it.skipIf(module !== null)("leaves today's thresholds where they are on a stack with no module", async () => {
    const small = await submitted(SMALL);
    const large = await submitted(LARGE);
    await closeTheWindow(large);
    await syncAll();
    const gasPriceWei = await pinTheGasPrice();

    const threshold = minimumProfitableBudget(FEE_BP, gasPriceWei, MODULELESS_FINALIZE_GAS, MARGIN_BPS);
    expect(threshold as bigint).toBeLessThan(SMALL);
    expect(finalizeGasDefaults(false).finalizeGas).toBe(MODULELESS_FINALIZE_GAS);

    const { keeper, metrics } = keeperOver(MODULELESS_FINALIZE_GAS, GRACE);
    const report = await keeper.tick((await publicClient.getBlock()).timestamp);

    expect(report.finalized).toEqual(expect.arrayContaining([small, large]));
    expect(report.held).toEqual([]);
    expect(report.skipped.find((entry) => entry.jobId === small)).toBeUndefined();
    expect(metrics.snapshot().releaseRefusals).toBe(0);
    expect(await keeperJobState.listHeld(db, 31337)).toEqual([]);
  }, 180_000);
});
