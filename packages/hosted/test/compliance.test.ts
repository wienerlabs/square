import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent, type Agent, type Listening } from "@squaresdk/agent";
import { createSquareClient, deploymentFor, deploymentFromJson, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { newPolicy, policyCommitment, type DutyEvent } from "@squaresdk/policy";
import { createLocalProver, type LocalProver } from "@squaresdk/policy/node";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { HostedAgentConfig } from "../src/config.js";
import { hostAgent, type HostedAgent } from "../src/host.js";
import { scriptedModel, type Step } from "./helpers/scriptedModel.js";

/**
 * square#335 through the hosted agent: on a stack whose hook holds a module,
 * a job the host delegates is proved under the host wallet's policy and
 * released by the host when its window closes, and the sub-agent holds the
 * whole net. The proof is made in this process, from the key the module was
 * keyed to (square#347). Needs the compliance stack
 * (packages/policy/test/helpers/stack.ts); skipped without it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const artifacts = process.env["SQUARE_PROVER_ARTIFACTS"] ?? process.env["PROVER_ARTIFACTS_DIR"] ?? join(HERE, "..", "..", "..", "services", "prover", "artifacts");
const DEPLOYMENT_FILE = process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(HERE, "..", "..", "..", "contracts", "deployments", "31337.json");
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

async function json(url: string, body?: string): Promise<unknown> {
  try {
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body } : {}) });
    return await response.json();
  } catch {
    return null;
  }
}

function localDeployment(): SquareDeployment {
  return existsSync(DEPLOYMENT_FILE) ? deploymentFromJson(JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"))) : deploymentFor(31337);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function complianceStackReady(): Promise<string | null> {
  if ((await json(rpcUrl, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })) as { result?: string } | null)?.result !== "0x7a69") return `no anvil at ${rpcUrl}`;
  if (!["payment.wasm", "payment.zkey", "payment_vk.json"].every((file) => existsSync(join(artifacts, file)))) return `no proving artifacts at ${artifacts}`;
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  if ((await createSquareClient({ publicClient, deployment: localDeployment() }).complianceModule()) === null) return `no compliance module on the stack at ${rpcUrl}`;
  return null;
}

const notReady = await complianceStackReady();

describe.skipIf(notReady !== null)("a hosted agent's delegated job is proved and released under its wallet's policy", () => {
  const deployment = localDeployment();
  const pollingInterval = 500;
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index), pollingInterval });
  const hirer = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const scribeClient = createSquareClient({ publicClient, deployment, walletClient: wallet(3) });
  const CALLER = `did:aip:eip155:31337:${deployment.identityRegistry.toLowerCase()}:9`;

  let scribe: Agent;
  let scribeListening: Listening;
  let scribeUrl: string;
  let hosted: HostedAgent;
  let hostedListening: Listening;
  let hostedUrl: string;
  const events: DutyEvent[] = [];
  let prover: LocalProver | undefined;

  beforeAll(async () => {
    // Agent 2 for anvil account 3; the mock registry lets anyone set it.
    await wallet(0).writeContract({
      address: deployment.identityRegistry,
      abi: [{ type: "function", name: "setAgent", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "owner", type: "address" }, { name: "wallet", type: "address" }], outputs: [] }],
      functionName: "setAgent",
      args: [2n, account(3).address, account(3).address],
    });
    const scribePort = await freePort();
    scribeUrl = `http://127.0.0.1:${scribePort}`;
    scribe = createAgent({ name: "Scribe", description: "Summarises.", walletClient: wallet(3), publicClient, deployment, agentId: 2n, url: scribeUrl }).capability("text.summarize", {
      description: "Summarise a document.",
      price: "0.10",
      handler: async ({ input }) => `${input.split(/\s+/).length} words`,
    });
    scribeListening = await scribe.listen(scribePort, "127.0.0.1");

    const hostedPort = await freePort();
    hostedUrl = `http://127.0.0.1:${hostedPort}`;
    const config: HostedAgentConfig = {
      name: "Acme Research",
      description: "Briefs, with a summary from Scribe.",
      agentId: "1",
      url: hostedUrl,
      provider: { tier: "platform" },
      capabilities: [{ id: "research.brief", description: "A brief.", price: "0.50", instructions: "Write a brief; delegate the summary.", delegate: true }],
      delegation: { allow: [scribeUrl], maxPerJob: "0.45" },
      compliance: { policyFile: "policy.json", intervalMs: 2000 },
    };
    // The host wallet's policy: what it delegates, in the stack's USDC, under a daily ceiling.
    const policy = newPolicy({
      operator: account(2).address,
      maxDailySpend: parseUnits("50", 6),
      maxPerTransaction: parseUnits("1", 6),
      categories: ["text.summarize"],
      tokens: [deployment.usdc],
    });
    const steps: Step[] = [
      { tools: [{ name: "delegate", input: { agent: scribeUrl, capability: "text.summarize", input: "one two three four" } }] },
      (request) => {
        const results = request.messages[request.messages.length - 1]!.content as Array<{ content: string }>;
        const job = /job (\d+) funded/.exec(results[0]!.content)?.[1];
        return { text: `Brief: four words, per Scribe (job ${job}).` };
      },
    ];
    hosted = await hostAgent(config, {
      walletClient: wallet(2),
      publicClient,
      deployment,
      rpcUrl,
      anthropic: () => scriptedModel(steps),
      pollIntervalMs: 200,
      compliance: { policy, prover: (prover = createLocalProver({ artifacts })), intervalMs: 2000, onEvent: (e) => events.push(e) },
    });
    await hosted.agent.client.setPolicy((await policyCommitment(policy)).hex, BigInt(policy.max_daily_spend));
    hostedListening = await hosted.agent.listen(hostedPort, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await hostedListening?.close();
    await scribeListening?.close();
    await hosted?.close();
    await prover?.close();
  });

  const rpc = async (url: string, method: string, params: unknown) => {
    const response = await fetch(`${url}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 90_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms} ms; events: ${JSON.stringify(events, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  it("delegates under escrow, binds the subtask's proof when the window is about to close, and releases the whole net to Scribe", async () => {
    const block = await publicClient.getBlock({ blockTag: "pending" });
    const { jobId } = await hirer.createJob({ provider: hosted.agent.address, expiredAt: block.timestamp + 10n * 86_400n, spec: { task: "brief" } });
    await hirer.setBudget(jobId, parseUnits("0.50", 6));
    await hirer.fund(jobId, parseUnits("0.50", 6));
    const created = await rpc(hostedUrl, "task/create", { taskId: `brief-${jobId}`, capability: "research.brief", input: "a document", callerDid: CALLER, jobId: jobId.toString() });
    expect(created.error).toBeUndefined();
    const done = await until(() => rpc(hostedUrl, "task/status", { taskId: `brief-${jobId}` }), (res) => res.result?.["state"] !== "WORKING", "the brief");
    expect(done.result).toMatchObject({ state: "DELIVERED" });

    // The delegated job: tracked from its funding with what it bought and what it holds, and nothing bound while the window has a day to run (square#349).
    const tracked = hosted.duty!.jobs();
    expect(tracked).toHaveLength(1);
    const subJob = tracked[0]!.jobId;
    expect(tracked[0]).toMatchObject({ category: "text.summarize", budget: parseUnits("0.10", 6) });
    expect(await hosted.duty!.tick()).toMatchObject({ waiting: [subJob], bound: [] });
    expect(await hosted.agent.client.complianceProofOf(subJob)).toBe("0x");
    const net = await hosted.agent.client.netPayout(subJob);
    const owedBefore = await scribeClient.withdrawable(account(3).address);

    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    await until(() => Promise.resolve(events), (list) => list.some((e) => e.type === "released" && e.jobId === subJob), "the release", 120_000);
    expect(events.filter((e) => e.type === "bound" && e.jobId === subJob)).toHaveLength(1);
    const released = events.find((e) => e.type === "released" && e.jobId === subJob);
    expect(released).toMatchObject({ verified: true, payee: account(3).address, amount: net });
    expect((await hosted.agent.client.getJobRecord(subJob)).status).toBe(JobStatus.Completed);
    expect((await scribeClient.withdrawable(account(3).address)) - owedBefore).toBe(net);
    expect(hosted.duty!.jobs()).toEqual([]);
  }, 300_000);
});
