import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Address } from "viem";
import { foundry } from "viem/chains";
import { anvilAccount } from "./anvil.js";
import {
  arbitrationAbi,
  claimMarketAbi,
  createSquareClient,
  decodeSquareLogs,
  deploymentFor,
  deploymentFromJson,
  hashDeliverable,
  keeperEvaluatorAbi,
  Outcome,
  squareJobAbi,
  type SquareDeployment,
} from "@squaresdk/core";
import { ledgerKey, reduce } from "../src/reducer.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

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

function localDeployment(): SquareDeployment {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "..", "..", "contracts", "deployments", "31337.json");
  if (existsSync(file)) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(31337);
}

const reachable = await anvilReachable();

describe.skipIf(!reachable)("state rebuilt from logs equals state read from the chain", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const actor = (index: number) =>
    createSquareClient({
      publicClient,
      deployment,
      walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: anvilAccount(index) }),
    });
  const client = actor(1);
  const provider = actor(2);
  const buyer = actor(3);
  const arbiterA = actor(4);
  const arbiterB = actor(5);
  const cranker = actor(7);
  const budget = parseUnits("40", 6);

  async function submitted(): Promise<bigint> {
    const latest = await publicClient.getBlock();
    const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { diff: true, n: Date.now() } });
    await provider.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await provider.submit({ jobId, deliverable: hashDeliverable(`work ${jobId}`), agentId: 1n });
    return jobId;
  }

  async function passWindow(jobId: bigint): Promise<void> {
    const end = await client.challengeEndsAt(jobId);
    const latest = await publicClient.getBlock();
    const gap = BigInt(end) - latest.timestamp + 1n;
    await testClient.increaseTime({ seconds: Number(gap > 0n ? gap : 1n) });
    await testClient.mine({ blocks: 1 });
  }

  it("matches every job, ledger balance, dispute and listing", async () => {
    const finalized = await submitted();
    await passWindow(finalized);
    await cranker.finalize(finalized);
    await provider.withdraw();

    const rejected = await submitted();
    await client.dispute(rejected, hashDeliverable("evidence"));
    await arbiterA.vote(rejected, Outcome.Reject, 0);
    await arbiterB.vote(rejected, Outcome.Reject, 0);
    await client.withdrawBond();

    const sold = await submitted();
    await provider.listClaim(sold, parseUnits("35", 6));
    await buyer.buyClaim(sold);
    await passWindow(sold);
    await cranker.finalize(sold);

    const pending = await submitted();
    await provider.listClaim(pending, parseUnits("30", 6));
    await provider.cancelClaim(pending);

    const addresses = [deployment.squareJob, deployment.keeperEvaluator, deployment.arbitration, deployment.claimMarket, deployment.squareHook];
    const logs = await publicClient.getLogs({ address: addresses, fromBlock: 0n, toBlock: "latest" });
    const state = reduce(decodeSquareLogs(logs, deployment));

    const count = await client.jobCounter();
    expect(BigInt(state.jobs.size)).toBe(count);
    for (let id = 1n; id <= count; id++) {
      const local = state.jobs.get(id);
      const chain = await publicClient.readContract({ abi: squareJobAbi, address: deployment.squareJob, functionName: "getJobRecord", args: [id] });
      expect(local, `job ${id} missing locally`).toBeDefined();
      if (!local) continue;
      expect(local.status).toBe(chain.status);
      expect(local.budget).toBe(chain.budget);
      expect(local.client.toLowerCase()).toBe(chain.client.toLowerCase());
      expect((local.provider ?? "0x0000000000000000000000000000000000000000").toLowerCase()).toBe(chain.provider.toLowerCase());
      expect(local.expiredAt).toBe(BigInt(chain.expiredAt));
      expect(local.createdAt).toBe(BigInt(chain.createdAt));
      expect(local.fundedAt ?? 0n).toBe(BigInt(chain.fundedAt));
      expect(local.submittedAt ?? 0n).toBe(BigInt(chain.submittedAt));
      expect(local.platformFeeBP ?? 0).toBe(chain.platformFeeBP);
      expect(local.evaluatorFeeBP ?? 0).toBe(chain.evaluatorFeeBP);
      expect(local.deliverable ?? "0x0000000000000000000000000000000000000000000000000000000000000000").toBe(chain.deliverable);
      expect((local.payee ?? "0x0000000000000000000000000000000000000000").toLowerCase()).toBe(chain.payee.toLowerCase());
      expect(local.providerBps ?? 0).toBe(chain.providerBps);
      expect(local.description).toBe(chain.description);
      const chainEnd = await publicClient.readContract({ abi: keeperEvaluatorAbi, address: deployment.keeperEvaluator, functionName: "challengeEndsAt", args: [id] });
      expect(local.challengeEnd ?? 0n).toBe(BigInt(chainEnd));
      const disputedOnChain = await publicClient.readContract({ abi: keeperEvaluatorAbi, address: deployment.keeperEvaluator, functionName: "isDisputed", args: [id] });
      expect(local.disputed).toBe(disputedOnChain);
      const listing = await publicClient.readContract({ abi: claimMarketAbi, address: deployment.claimMarket, functionName: "getListing", args: [id] });
      const localListing = state.listings.get(id);
      expect(localListing?.status ?? 0).toBe(listing.status);
      if (localListing) {
        expect(localListing.price).toBe(listing.price);
        expect(localListing.faceValue).toBe(listing.faceValue);
        expect((localListing.buyer ?? "0x0000000000000000000000000000000000000000").toLowerCase()).toBe(listing.buyer.toLowerCase());
      }
      const dispute = await publicClient.readContract({ abi: arbitrationAbi, address: deployment.arbitration, functionName: "disputeOf", args: [id] });
      const localDispute = state.disputes.get(id);
      expect(localDispute?.bond ?? 0n).toBe(dispute.bond);
      expect(localDispute?.outcome ?? 0).toBe(dispute.outcome);
    }

    const accounts = [client.account, provider.account, buyer.account, cranker.account, deployment.keeperEvaluator] as Address[];
    for (const account of accounts) {
      const onChain = await publicClient.readContract({ abi: squareJobAbi, address: deployment.squareJob, functionName: "withdrawable", args: [account] });
      expect(state.ledger.get(ledgerKey("SquareJob", account)) ?? 0n, `ledger of ${account}`).toBe(onChain);
      const bond = await publicClient.readContract({ abi: arbitrationAbi, address: deployment.arbitration, functionName: "withdrawable", args: [account] });
      expect(state.ledger.get(ledgerKey("Arbitration", account)) ?? 0n).toBe(bond);
    }
  }, 120_000);
});
