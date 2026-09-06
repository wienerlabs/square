import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  createSquareClient,
  deploymentFor,
  deploymentFromJson,
  eventsNamed,
  finalizeReason,
  hashDeliverable,
  JobStatus,
  Outcome,
  type SquareClient,
  type SquareDeployment,
} from "../src/index.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
] as const;

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await response.json()) as { result?: string };
    return body.result === "0x7a69";
  } catch {
    return false;
  }
}

function localDeployment(): SquareDeployment {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "..", "..", "contracts", "deployments", "31337.json");
  if (existsSync(file)) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(31337);
}

const reachable = await anvilReachable();

describe.skipIf(!reachable)("lifecycle on anvil through the SDK", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const actor = (index: number): SquareClient =>
    createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({
        chain: foundry,
        transport: http(rpcUrl),
        account: privateKeyToAccount(keys[index] as Hex),
      }),
    });

  const client = actor(1);
  const provider = actor(2);
  const buyer = actor(3);
  const arbiterA = actor(4);
  const arbiterB = actor(5);
  const cranker = actor(7);
  const budget = parseUnits("100", 6);
  const net = budget - (budget * 100n) / 10_000n - (budget * 50n) / 10_000n;
  const evaluatorFee = (budget * 50n) / 10_000n;
  const deliverable = hashDeliverable("the delivered work");

  async function submittedJob(): Promise<bigint> {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({
      provider: provider.account,
      expiredAt: latest.timestamp + 30n * 24n * 3600n,
      spec: { task: "translate", words: 1200 },
    });
    await provider.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await provider.submit({ jobId, deliverable, agentId: 1n });
    return jobId;
  }

  async function passWindow(jobId: bigint): Promise<void> {
    const end = await client.challengeEndsAt(jobId);
    const latest = await publicClient.getBlock();
    const gap = BigInt(end) - latest.timestamp + 1n;
    await testClient.increaseTime({ seconds: Number(gap > 0n ? gap : 1n) });
    await testClient.mine({ blocks: 1 });
  }

  beforeAll(async () => {
    expect(await client.settlementHorizon()).toBe(4 * 24 * 3600);
  });

  it("optimistic path: create, fund, submit, finalize, withdraw", async () => {
    const jobId = await submittedJob();
    const record = await provider.getJobRecord(jobId);
    expect(record.status).toBe(JobStatus.Submitted);
    expect(record.deliverable).toBe(deliverable);
    expect(await provider.agentOf(jobId)).toBe(1n);
    expect(await provider.netPayout(jobId)).toBe(net);

    await expect(cranker.finalize(jobId)).rejects.toThrow(/WindowOpen/);
    await passWindow(jobId);

    const crankerBefore = await cranker.usdcBalance(cranker.account);
    const finalized = await cranker.finalize(jobId);
    const names = finalized.events.map((e) => `${e.contract}.${e.eventName}`);
    expect(names).toContain("SquareJob.JobCompleted");
    expect(names).toContain("SquareJob.PaymentReleased");
    expect(names).toContain("KeeperEvaluator.Finalized");
    expect(names).toContain("SquareHook.ReputationRecorded");
    const completed = eventsNamed(finalized.events, "JobCompleted")[0];
    expect(completed?.args.reason).toBe(finalizeReason(jobId, deliverable));
    expect((await cranker.usdcBalance(cranker.account)) - crankerBefore).toBe(evaluatorFee);

    expect(await provider.withdrawable(provider.account)).toBe(net);
    const before = await provider.usdcBalance(provider.account);
    await provider.withdraw();
    expect((await provider.usdcBalance(provider.account)) - before).toBe(net);
    expect((await provider.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
  });

  it("dispute path: bonded dispute, two votes, rejection refunds the client", async () => {
    const jobId = await submittedJob();
    const bond = await client.bondFor(budget);
    const disputed = await client.dispute(jobId, hashDeliverable("evidence"));
    expect(disputed.events.map((e) => e.eventName)).toContain("DisputeOpened");
    expect(await client.isDisputed(jobId)).toBe(true);
    await expect(cranker.finalize(jobId)).rejects.toThrow(/Disputed/);

    await arbiterA.vote(jobId, Outcome.Reject, 0);
    const decided = await arbiterB.vote(jobId, Outcome.Reject, 0);
    expect(decided.events.map((e) => e.eventName)).toContain("DecisionReached");
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Rejected);
    expect(await client.withdrawable(client.account)).toBeGreaterThanOrEqual(budget);
    expect(await client.bondWithdrawable(client.account)).toBe(bond);
    await client.withdrawBond();
    expect(await client.bondWithdrawable(client.account)).toBe(0n);
  });

  it("receivable path: the buyer is paid at finalize, the provider is paid at sale", async () => {
    const jobId = await submittedJob();
    const price = parseUnits("90", 6);
    await provider.listClaim(jobId, price);
    const providerBefore = await provider.usdcBalance(provider.account);
    await buyer.buyClaim(jobId);
    expect((await provider.usdcBalance(provider.account)) - providerBefore).toBe(price);
    expect(await buyer.payeeOf(jobId)).toBe(buyer.account);

    await passWindow(jobId);
    const buyerBefore = await buyer.withdrawable(buyer.account);
    const finalized = await cranker.finalize(jobId);
    const released = eventsNamed(finalized.events, "PaymentReleased")[0];
    expect(released?.args.provider).toBe(buyer.account);
    expect((await buyer.withdrawable(buyer.account)) - buyerBefore).toBe(net);
    expect(await provider.agentOf(jobId)).toBe(1n);
  });

  it("spec hash written on chain matches the SDK", async () => {
    const spec = { task: "audit", scope: ["a", "b"] };
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({
      provider: provider.account,
      expiredAt: latest.timestamp + 30n * 24n * 3600n,
      spec,
    });
    const job = await client.getJob(jobId);
    expect(job.description).toBe(`spec:${(await import("../src/index.js")).specHash(spec)}`);
  });
});
