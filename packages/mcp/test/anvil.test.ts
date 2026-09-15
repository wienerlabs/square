import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAgent, type Agent, type Listening } from "@squaresdk/agent";
import { createSquareClient, deploymentFor, deploymentFromJson, eventsNamed, hashDeliverable, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { bridgeTools, ToolPool } from "../src/index.js";
import { startToolServer, type ToolServer } from "./helpers/toolServer.js";

/**
 * Both acceptance criteria of square#40 on a local chain, in one loop.
 *
 * Agent → tool: an agent built with `@squaresdk/agent` offers the tools of
 * an MCP server as its capabilities (`bridgeTools` over a `ToolPool`), so
 * delivering a task means calling the tool. Claude → agent: the `square-mcp`
 * binary is spawned over stdio, the transport Claude Desktop uses, and an
 * MCP client hires the agent through it: the job is funded on SquareJob,
 * the task runs, the tool is called, the deliverable's hash lands with the
 * agent's submit, and after the crank the provider is paid. Needs anvil
 * with DeployLocal.s.sol on it and the package built; skipped without the
 * chain, the way packages/agent's suite is.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const DEPLOYMENT_FILE = join(HERE, "..", "..", "..", "contracts", "deployments", "31337.json");
const BIN = join(HERE, "..", "dist", "bin.js");

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
  return existsSync(DEPLOYMENT_FILE) ? deploymentFromJson(JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"))) : deploymentFor(31337);
}

/** A port nobody holds, so the card can name the endpoint before the agent listens on it. */
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

const reachable = await anvilReachable();

describe.skipIf(!reachable)("an agent calls an MCP tool, and Claude hires the agent through the Square MCP server", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index) });
  const hirer = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const cranker = createSquareClient({ publicClient, deployment, walletClient: wallet(3) });
  const AGENT_DID = `did:aip:eip155:31337:${deployment.identityRegistry.toLowerCase()}:1`;

  let weather: ToolServer;
  let pool: ToolPool;
  let agent: Agent;
  let listening: Listening;
  let agentUrl: string;
  let client: Client;
  let jobId: string;
  let deliverable: `0x${string}`;

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} is not built; run npm run build first`);

    // Agent → tool. Anvil account 2 owns mock agent 1 (DeployLocal seeds it).
    weather = await startToolServer({ name: "weather" });
    pool = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache: false });
    const port = await freePort();
    agentUrl = `http://127.0.0.1:${port}`;
    agent = createAgent({
      name: "Meteo",
      description: "Tomorrow's weather, from an MCP server.",
      walletClient: wallet(2),
      publicClient,
      deployment,
      agentId: 1n,
      url: agentUrl,
    });
    const bridged = await bridgeTools(agent, pool, { price: "0.10", include: (tool) => tool.tool === "forecast" });
    expect(bridged.map((b) => b.id)).toEqual(["mcp.weather.forecast"]);
    listening = await agent.listen(port, "127.0.0.1");

    // Claude → agent: the binary over stdio, configured the way a desktop client would configure it.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: {
        ...getDefaultEnvironment(),
        SQUARE_CHAIN_ID: "31337",
        SQUARE_RPC_URL: rpcUrl,
        SQUARE_DEPLOYMENT_FILE: DEPLOYMENT_FILE,
        SQUARE_PRIVATE_KEY: `0x${Buffer.from(account(1).getHdKey().privateKey!).toString("hex")}`,
        SQUARE_X402_MAX_PAYMENT: "off",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "claude-desktop-stand-in", version: "0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await listening?.close();
    await pool?.close();
    await weather?.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

  it("serves the hiring tools, and finds the agent by its URL with the chain's owner and the bridged capability", async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["square_agent", "square_dispatch", "square_hire", "square_job", "square_refund", "square_task"]);
    const result = await call("square_agent", { agent: agentUrl });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      did: AGENT_DID,
      agentId: "1",
      owner: account(2).address,
      provider: account(2).address,
      name: "Meteo",
      a2aEndpoint: `${agentUrl}/a2a`,
      capabilities: [{ id: "mcp.weather.forecast", description: "Tomorrow's weather in a city.", price: "0.10" }],
    });
    // The mock registry has no tokenURI, so the chain names no endpoint and the card's is used, and the profile says so.
    expect((result.structuredContent as { warnings: string[] }).warnings).toContainEqual(expect.stringMatching(/the chain names no A2A endpoint/));
  }, 30_000);

  it("hires: the job is funded from the wallet, the agent calls the tool, and the submit carries the tool's answer", async () => {
    const before = await hirer.usdcBalance(account(1).address);
    const calls = weather.calls.length;
    const result = await call("square_hire", { agent: agentUrl, capability: "mcp.weather.forecast", input: "Berlin" });
    expect(result.isError, textOf(result)).toBeFalsy();
    const content = result.structuredContent as { jobId: string; taskId: string; task: { state: string; deliverable: `0x${string}`; reference: `0x${string}` }; job: { status: string }; transactions: Record<string, `0x${string}`> };
    jobId = content.jobId;
    deliverable = hashDeliverable("Berlin: sunny");
    expect(content.taskId).toBe(`square-job-${jobId}`);
    expect(content.task).toMatchObject({ state: "DELIVERED", deliverable });
    expect(content.job).toEqual({ status: "Submitted" });
    expect(weather.calls.slice(calls)).toEqual([{ tool: "forecast", args: { city: "Berlin" } }]);

    // The chain agrees with the tool result: funded by the wallet, submitted by the agent, bound to agent 1.
    const record = await hirer.getJobRecord(BigInt(jobId));
    expect(record.status).toBe(JobStatus.Submitted);
    expect(record.client).toBe(account(1).address);
    expect(record.provider).toBe(account(2).address);
    expect(record.budget).toBe(parseUnits("0.10", 6));
    expect(record.deliverable).toBe(deliverable);
    expect(await hirer.agentOf(BigInt(jobId))).toBe(1n);
    expect(before - (await hirer.usdcBalance(account(1).address))).toBe(parseUnits("0.10", 6));
    const receipt = await publicClient.getTransactionReceipt({ hash: content.task.reference });
    expect(eventsNamed(hirer.decodeReceipt(receipt), "JobSubmitted").map((e) => [e.args.jobId, e.args.deliverable])).toEqual([[BigInt(jobId), deliverable]]);
    for (const name of ["createJob", "setBudget", "fund"]) {
      const tx = await publicClient.getTransactionReceipt({ hash: content.transactions[name]! });
      expect(tx.status, name).toBe("success");
    }
  }, 120_000);

  it("reads the job as Submitted, and as Completed with the provider paid once the crank finalizes", async () => {
    const submitted = await call("square_job", { jobId });
    expect(submitted.structuredContent).toMatchObject({ jobId, status: "Submitted", deliverable, agentId: "1", budget: "0.1" });
    const task = await call("square_task", { agent: agentUrl, taskId: `square-job-${jobId}` });
    expect(task.structuredContent).toMatchObject({ task: { state: "DELIVERED", deliverable }, job: { status: "Submitted" } });

    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    await cranker.finalize(BigInt(jobId));
    const completed = await call("square_job", { jobId });
    expect(completed.structuredContent).toMatchObject({ status: "Completed" });
    expect(await agent.client.withdrawable(account(2).address)).toBeGreaterThan(0n);
  }, 120_000);

  it("refuses a hire the agent would refuse before spending, and reports one the agent refused after funding", async () => {
    const cheap = await call("square_hire", { agent: agentUrl, capability: "mcp.weather.forecast", input: "Oslo", budget: "0.01" });
    expect(cheap.isError).toBe(true);
    expect(textOf(cheap)).toMatch(/budget 0.01 is below the price/);
    const unknown = await call("square_hire", { agent: agentUrl, capability: "mcp.weather.slow", input: "x" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/does not offer mcp.weather.slow/);
  }, 60_000);
});
