import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAgent, type Agent, type Listening } from "@squaresdk/agent";
import { createSquareClient, deploymentFor, deploymentFromJson, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { newPolicy, policyCommitment, policyToJson } from "@squaresdk/policy";
import { createPublicClient, createTestClient, createWalletClient, formatUnits, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/**
 * square#335 through the MCP bridge: on a stack whose hook holds a compliance
 * module, a hire through `square-mcp` configured with the institution's
 * policy and the circuit's files ends with the provider paid the whole net,
 * because the server proved in its own process, bound the proof to the job and
 * released it when the window closed. Needs the compliance stack
 * (packages/policy/test/helpers/stack.ts: anvil, a module keyed to the proving
 * key, that key's files); skipped without it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const artifacts = process.env["SQUARE_PROVER_ARTIFACTS"] ?? process.env["PROVER_ARTIFACTS_DIR"] ?? join(HERE, "..", "..", "..", "services", "prover", "artifacts");
const DEPLOYMENT_FILE = process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(HERE, "..", "..", "..", "contracts", "deployments", "31337.json");
const BIN = join(HERE, "..", "dist", "bin.js");
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
  const reader = createSquareClient({ publicClient, deployment: localDeployment() });
  if ((await reader.complianceModule()) === null) return `no compliance module on the stack at ${rpcUrl}`;
  return null;
}

const notReady = await complianceStackReady();

describe.skipIf(notReady !== null)("a hire through square-mcp is proved and released under the institution's policy", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index) });
  const institution = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const provider = createSquareClient({ publicClient, deployment, walletClient: wallet(2) });

  let agent: Agent;
  let listening: Listening;
  let agentUrl: string;
  let client: Client;
  let stderr = "";
  let policyFile = "";

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} is not built; run npm run build first`);
    // The institution's policy: this wallet, the stack's USDC, the capability it will buy.
    const policy = newPolicy({
      operator: account(1).address,
      maxDailySpend: parseUnits("100", 6),
      maxPerTransaction: parseUnits("5", 6),
      categories: ["text.summarize"],
      tokens: [deployment.usdc],
    });
    await institution.setPolicy((await policyCommitment(policy)).hex, BigInt(policy.max_daily_spend));
    policyFile = join(mkdtempSync(join(tmpdir(), "square-policy-")), "policy.json");
    writeFileSync(policyFile, policyToJson(policy));

    const port = await freePort();
    agentUrl = `http://127.0.0.1:${port}`;
    agent = createAgent({
      name: "Atlas",
      description: "Summarises what it is given.",
      walletClient: wallet(2),
      publicClient,
      deployment,
      agentId: 1n,
      url: agentUrl,
    }).capability("text.summarize", {
      description: "The first three words.",
      price: "1.00",
      handler: async ({ input }) => input.split(/\s+/).slice(0, 3).join(" "),
    });
    listening = await agent.listen(port, "127.0.0.1");

    ({ client } = await start(policyFile));
  }, 120_000);

  /** A `square-mcp` process over stdio, the way a desktop client launches one; the same env twice is a restart. */
  async function start(policyFile: string): Promise<{ client: Client }> {
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
        SQUARE_POLICY_FILE: policyFile,
        SQUARE_PROVER_ARTIFACTS: artifacts,
        SQUARE_COMPLIANCE_INTERVAL_MS: "2000",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const started = new Client({ name: "claude-desktop-stand-in", version: "0" });
    await started.connect(transport);
    return { client: started };
  }

  afterAll(async () => {
    await client?.close();
    await listening?.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 90_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms} ms\n${stderr}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  it("hires, keeps the job across a restart of the server, and after the window binds one proof and pays the provider the whole net", async () => {
    const owedBefore = await provider.withdrawable(account(2).address);

    const hired = await call("square_hire", { agent: agentUrl, capability: "text.summarize", input: "one two three four five" });
    expect(hired.isError, textOf(hired)).toBeFalsy();
    expect(textOf(hired)).toMatch(/keeps the job's compliance proof current/);
    const jobId = (hired.structuredContent as { jobId: string }).jobId;
    expect(hired.structuredContent).toMatchObject({ task: { state: "DELIVERED" } });

    // A day to the close: the duty tracks the job and binds nothing yet (square#349).
    const tracked = await call("square_job", { jobId });
    expect(tracked.structuredContent).toMatchObject({ status: "Submitted", compliance: { proof: "none", tracked: true, payee: account(2).address } });
    expect((tracked.structuredContent as { compliance: { summary: string } }).compliance.summary).toContain("binds one when the window is within half the tolerance of closing");
    expect(await institution.complianceProofOf(BigInt(jobId))).toBe("0x");
    const net = await institution.netPayout(BigInt(jobId));

    // The server restarts. The state file beside the policy carries the job (square#348).
    await client.close();
    const restarted = await start(policyFile);
    client = restarted.client;
    await until(() => Promise.resolve(stderr), (log) => log.includes("recovered 1 job(s): 1 from the state"), "the recovery", 20_000);
    const still = await call("square_job", { jobId });
    expect(still.structuredContent).toMatchObject({ compliance: { proof: "none", tracked: true } });

    // The window closes; the duty binds once and cranks, and the module verifies.
    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    await until(
      () => institution.getJobRecord(BigInt(jobId)),
      (record) => record.status === JobStatus.Completed,
      "the release",
      120_000,
    );
    // The server says what it did; the pipe may lag the chain by a moment.
    await until(() => Promise.resolve(stderr), (log) => log.includes(`job ${jobId}: released in`), "the server's report", 10_000);
    expect(stderr.match(new RegExp(`job ${jobId}: proof bound in`, "g"))).toHaveLength(1);
    expect(stderr).toContain(`job ${jobId}: released in 0x`);
    expect(stderr).toContain(`, ${formatUnits(net, 6)} USDC to ${account(2).address}`);
    expect((await provider.withdrawable(account(2).address)) - owedBefore).toBe(net);
    // The counter moved by this release on the day the release fell in (the warp crossed midnight).
    expect(await institution.spentToday(account(1).address)).toBeGreaterThanOrEqual(net);
    const settled = await call("square_job", { jobId });
    expect(settled.structuredContent).toMatchObject({ status: "Completed" });
    expect((settled.structuredContent as { compliance?: unknown }).compliance).toBeUndefined();
    // And the state file no longer holds it.
    expect(JSON.parse(readFileSync(`${policyFile}.duty.json`, "utf8"))).toEqual({ jobs: [] });
  }, 300_000);
});
