import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  createSquareClient,
  deploymentFor,
  deploymentFromJson,
  eventsNamed,
  hashDeliverable,
  JobStatus,
  squareJobAbi,
  type SquareClient,
  type SquareDeployment,
} from "@squaresdk/core";
import { createAgent, MIN_SETTLEMENT_WINDOW, settlementWindowOf, type Agent, type Listening } from "../src/index.js";

/**
 * The acceptance criterion of square#79, on a local chain: an A2A task is
 * opened against a funded job, delivered by the on-chain submit, finalized by
 * the evaluator's crank, and the provider withdraws. Needs anvil with
 * contracts/script/DeployLocal.s.sol on it; skipped otherwise, the way
 * packages/core's anvil suite is.
 */
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

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
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "deployments", "31337.json");
  return existsSync(file) ? deploymentFromJson(JSON.parse(readFileSync(file, "utf8"))) : deploymentFor(31337);
}

const reachable = await anvilReachable();

describe.skipIf(!reachable)("an agent takes a funded task, delivers it on chain, and is paid", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index) });
  const client: SquareClient = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const cranker: SquareClient = createSquareClient({ publicClient, deployment, walletClient: wallet(3) });
  const budget = parseUnits("5", 6);
  const CALLER = `did:aip:eip155:31337:${deployment.identityRegistry.toLowerCase()}:2`;

  let agent: Agent;
  let listening: Listening;
  let jobId: bigint;
  const seen: string[] = [];

  beforeAll(async () => {
    // Anvil account 2 owns mock agent 1 (DeployLocal seeds it); it is the provider.
    agent = createAgent({
      name: "Atlas",
      description: "Summarises what it is given.",
      walletClient: wallet(2),
      publicClient,
      deployment,
      agentId: 1n,
      url: "http://127.0.0.1",
    }).capability("text.summarize", {
      description: "The first three words.",
      price: "1.00",
      handler: async ({ input, jobId: id }) => {
        seen.push(id);
        return input.split(/\s+/).slice(0, 3).join(" ");
      },
    });
    listening = await agent.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await listening?.close();
  });

  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`${listening.url}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };

  async function untilTerminal(taskId: string) {
    for (let i = 0; i < 200; i += 1) {
      const res = await rpc("task/status", { taskId });
      if (res.result && res.result["state"] !== "WORKING") return res.result;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("task never left WORKING");
  }

  it("refuses a task against a job that is not funded", async () => {
    const block = await publicClient.getBlock();
    const open = await client.createJob({ provider: agent.address, expiredAt: block.timestamp + 10n * 86_400n, spec: { task: "summarise" } });
    const res = await rpc("task/create", { taskId: "unfunded", capability: "text.summarize", input: "a b c d", callerDid: CALLER, jobId: open.jobId.toString() });
    expect(res.error).toMatchObject({ code: -32004, message: `job ${open.jobId} is Open, not Funded` });
    expect(seen).toEqual([]);
  }, 60_000);

  it("mirrors the kernel's settlement floor", async () => {
    const floor = await publicClient.readContract({ abi: squareJobAbi, address: deployment.squareJob, functionName: "MIN_SETTLEMENT_WINDOW" });
    expect(BigInt(floor)).toBe(MIN_SETTLEMENT_WINDOW);
  });

  // The kernel takes a job's expiry down to now + horizon at createJob and
  // funds it with no look at the window at all (square#326), while submit
  // wants the whole settlement window still ahead of expiredAt. A job that
  // has slipped between the two is Funded and undeliverable (square#334).
  async function fundedWithWindowLeft(secondsPastTheWindow: bigint): Promise<bigint> {
    const horizon = BigInt(await client.settlementHorizon());
    const window = settlementWindowOf(horizon);
    // The next block's timestamp, not the last one's: anvil's clock may have
    // been moved ahead of the latest block by an earlier test.
    const pending = await publicClient.getBlock({ blockTag: "pending" });
    const { jobId: id } = await client.createJob({ provider: agent.address, expiredAt: pending.timestamp + window + secondsPastTheWindow, spec: { task: "summarise" } });
    await agent.client.setBudget(id, budget);
    await client.fund(id, budget);
    expect((await client.getJobRecord(id)).status).toBe(JobStatus.Funded);
    return id;
  }

  it("refuses a funded job whose submit window has closed, with the window in the reason, before any handler runs", async () => {
    const id = await fundedWithWindowLeft(60n);
    await testClient.increaseTime({ seconds: 120 });
    await testClient.mine({ blocks: 1 });
    const res = await rpc("task/create", { taskId: "closed", capability: "text.summarize", input: "a b c d", callerDid: CALLER, jobId: id.toString() });
    expect(res.error?.code).toBe(-32004);
    expect(res.error?.message).toMatch(new RegExp(`^job ${id} cannot be submitted: it expires at \\d+, \\d+s from now, and submit needs \\d+s before expiry`));
    expect(seen).toEqual([]);
    // What the kernel says of the same job: the agent's answer is the chain's.
    await expect(agent.client.submit({ jobId: id, deliverable: hashDeliverable("a b c"), agentId: 1n })).rejects.toThrow(/ExpiryTooShort/);
  }, 60_000);

  it("delivers a funded job with just its window left", async () => {
    const id = await fundedWithWindowLeft(120n);
    const res = await rpc("task/create", { taskId: "narrow", capability: "text.summarize", input: "just in time for this", callerDid: CALLER, jobId: id.toString() });
    expect(res.result).toMatchObject({ state: "WORKING" });
    const done = await untilTerminal("narrow");
    expect(done).toMatchObject({ state: "DELIVERED", deliverable: hashDeliverable("just in time"), job: { status: JobStatus.Submitted } });
    expect(seen).toEqual([id.toString()]);
    seen.length = 0;
  }, 120_000);

  it("delivers a funded task through submit, bound to the agent, and the status reads the chain", async () => {
    const block = await publicClient.getBlock();
    ({ jobId } = await client.createJob({ provider: agent.address, expiredAt: block.timestamp + 10n * 86_400n, spec: { task: "summarise" } }));
    await agent.client.setBudget(jobId, budget);
    await client.fund(jobId, budget);
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Funded);

    const created = await rpc("task/create", { taskId: "paid", capability: "text.summarize", input: "one two three four five", callerDid: CALLER, jobId: jobId.toString() });
    expect(created.result).toMatchObject({ state: "WORKING" });
    const done = await untilTerminal("paid");

    const deliverable = hashDeliverable("one two three");
    expect(done).toMatchObject({ state: "DELIVERED", deliverable, job: { status: JobStatus.Submitted, name: "Submitted" } });
    expect(seen).toEqual([jobId.toString()]);

    // The reference is the submit, and the chain agrees with the task.
    const receipt = await publicClient.getTransactionReceipt({ hash: done["reference"] as `0x${string}` });
    const events = agent.client.decodeReceipt(receipt);
    expect(eventsNamed(events, "JobSubmitted").map((e) => [e.args.jobId, e.args.deliverable])).toEqual([[jobId, deliverable]]);
    expect(eventsNamed(events, "AgentBound").map((e) => [e.args.jobId, e.args.agentId])).toEqual([[jobId, 1n]]);
    const record = await client.getJobRecord(jobId);
    expect(record.status).toBe(JobStatus.Submitted);
    expect(record.deliverable).toBe(deliverable);
    expect(await agent.client.agentOf(jobId)).toBe(1n);
  }, 120_000);

  it("is paid once the evaluator's crank finalizes, and the task reports Completed without having stored it", async () => {
    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    await cranker.finalize(jobId);
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
    const status = await rpc("task/status", { taskId: "paid" });
    expect(status.result).toMatchObject({ state: "DELIVERED", job: { status: JobStatus.Completed, name: "Completed" } });

    const before = await agent.client.usdcBalance(agent.address);
    const owed = await agent.client.withdrawable(agent.address);
    expect(owed).toBe(await agent.client.netPayout(jobId));
    await agent.client.withdraw();
    expect((await agent.client.usdcBalance(agent.address)) - before).toBe(owed);
    expect(owed).toBe(parseUnits("4.925", 6));
  }, 120_000);
});
