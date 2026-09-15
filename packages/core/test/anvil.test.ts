import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseUnits, stringToHex, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { anvilAccount } from "./anvil.js";
import {
  approveBuyers,
  buyerLeaf,
  claimMarketAbi,
  createSquareClient,
  deploymentFor,
  deploymentFromJson,
  eventsNamed,
  finalizeReason,
  hashDeliverable,
  JobStatus,
  Outcome,
  PartyNotClearedError,
  screeningRegistryAbi,
  squareHookAbi,
  type Screener,
  type SquareClient,
  type SquareDeployment,
} from "../src/index.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";


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
        account: anvilAccount(index),
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
    expect(await client.settlementHorizon()).toBe(4 * 24 * 3600 + 3600);
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
    const approved = approveBuyers([buyer.account]);
    await client.setBuyerRoot(approved.root);
    const providerBefore = await provider.usdcBalance(provider.account);
    await buyer.buyClaim(jobId, approved.eligibilityOf(buyer.account));
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

  it("buyer list: the chain rebuilds the SDK's leaf, and refuses whoever is not on the list", async () => {
    const jobId = await submittedJob();
    await provider.listClaim(jobId, parseUnits("90", 6));
    const others = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
    const approved = approveBuyers([buyer.account, ...others]);
    await client.setBuyerRoot(approved.root);
    expect(await client.buyerRootOf(client.account)).toBe(approved.root);

    const eligibility = approved.eligibilityOf(buyer.account);
    const onChain = await publicClient.readContract({
      abi: claimMarketAbi,
      address: deployment.claimMarket,
      functionName: "buyerLeaf",
      args: [buyer.account, eligibility.salt],
    });
    expect(onChain).toBe(buyerLeaf(buyer.account, eligibility.salt));

    await expect(cranker.buyClaim(jobId, eligibility, { autoApprove: false })).rejects.toThrow(/BuyerNotEligible/);
    await buyer.buyClaim(jobId, eligibility);
    expect(await buyer.payeeOf(jobId)).toBe(buyer.account);
  });

  it("policy: the ceiling reads back as committed, the day's spend starts at zero, and a commitment outside the proof range is refused", async () => {
    const commitment = `0x${"00".repeat(31)}2a` as const; // a small field element, the way a Poseidon output is
    const dailyLimit = parseUnits("50", 6);
    const before = await client.policyOf(client.account);
    await client.setPolicy(commitment, dailyLimit);
    const policy = await client.policyOf(client.account);
    expect(policy.commitment).toBe(commitment);
    expect(policy.dailyLimit).toBe(dailyLimit);
    expect(policy.epoch).toBe(before.epoch + 1n);
    expect(await client.spentToday(client.account)).toBe(0n);
    await expect(client.setPolicy(`0x${"ff".repeat(32)}`, dailyLimit)).rejects.toThrow(/CommitmentOutsideProofRange/);
  });

  it("compliance proof: the client binds bytes to its job while Funded or Submitted, and reads them back; the slot says whether anything checks them", async () => {
    const jobId = await submittedJob();
    expect(await client.complianceProofOf(jobId)).toBe("0x");
    const proof = `0x${"ab".repeat(64)}` as const;
    await client.setComplianceProof(jobId, proof);
    expect(await client.complianceProofOf(jobId)).toBe(proof);
    // Only the job's client writes it (square#245).
    await expect(provider.setComplianceProof(jobId, proof)).rejects.toThrow(/Unauthorized|OnlyClient/);
    // The default local stack installs no module, so no release is gated and there is no tolerance to read.
    const module = await client.complianceModule();
    if (module === null) {
      expect(await client.complianceTolerance()).toBeNull();
      expect(await client.previewRelease({ jobId, payee: provider.account, amount: 1n, client: client.account, proof })).toBeNull();
    } else {
      expect(await client.complianceTolerance()).toBeGreaterThan(0n);
      expect(await client.previewRelease({ jobId, payee: provider.account, amount: 1n, client: client.account, proof })).toBe(false);
    }
  });

  it("screening: on a hook that screens, fund stops before sending for a party with no record, and sends once a screener has recorded both (square#368)", async () => {
    const registry = deployment.screeningRegistry;
    if (registry === undefined) {
      console.warn("the deployment record names no ScreeningRegistry: DeployLocal predates #222, the screening case is not run");
      return;
    }
    // The stack's owner installs the registry on the hook and registers a screener key for the length of this case.
    const owner = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(0) });
    const screenerAccount = anvilAccount(8);
    const screenerWallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: screenerAccount });
    const send = async (hash: Promise<`0x${string}`>) => publicClient.waitForTransactionReceipt({ hash: await hash });
    await send(owner.writeContract({ abi: squareHookAbi, address: deployment.squareHook, functionName: "setScreening", args: [registry] }));
    await send(owner.writeContract({ abi: screeningRegistryAbi, address: registry, functionName: "setScreener", args: [screenerAccount.address, true] }));
    try {
      const latest = await publicClient.getBlock();
      const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { task: "screened" } });
      await provider.setBudget(jobId, budget);
      // The registry is empty: the client itself is the first party the hook would refuse, and nothing is sent.
      const balance = await client.usdcBalance(client.account);
      const refused = await client.fund(jobId, budget).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PartyNotClearedError);
      expect(refused).toMatchObject({ jobId, role: "client", subject: client.account, state: "unscreened" });
      expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Open);
      expect(await client.usdcBalance(client.account)).toBe(balance);
      expect(await client.screeningOf(client.account)).toMatchObject({ state: "unscreened", registry });

      // A screener that does what the service does: signs a clean record per subject and submits it, answering after the receipt.
      const asked: Address[][] = [];
      const screener: Screener = {
        async screen(subjects) {
          asked.push([...subjects]);
          const block = await publicClient.getBlock();
          const screenings = subjects.map((subject) => ({ subject, sanctioned: false, screenedAt: block.timestamp, source: keccak256(stringToHex("test-screener")), evidence: keccak256(subject) }));
          const signatures: `0x${string}`[] = [];
          for (const screening of screenings) {
            const digest = await publicClient.readContract({ abi: screeningRegistryAbi, address: registry, functionName: "digestOf", args: [screening] });
            signatures.push(await screenerAccount.sign({ hash: digest }));
          }
          await send(screenerWallet.writeContract({ abi: screeningRegistryAbi, address: registry, functionName: "submitMany", args: [screenings, signatures] }));
        },
      };
      const screened = createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(1) }), screener });
      await screened.fund(jobId, budget);
      expect(asked).toEqual([[client.account, provider.account]]);
      expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Funded);
      expect(await client.screeningOf(provider.account)).toMatchObject({ state: "cleared", registry });
    } finally {
      await send(owner.writeContract({ abi: squareHookAbi, address: deployment.squareHook, functionName: "setScreening", args: [zeroAddress] }));
      await send(owner.writeContract({ abi: screeningRegistryAbi, address: registry, functionName: "setScreener", args: [screenerAccount.address, false] }));
    }
    expect(await client.screening()).toBeNull();
  }, 60_000);

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
