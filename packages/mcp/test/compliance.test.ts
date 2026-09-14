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
 * policy and a prover ends with the provider paid the whole net, because the
 * server bound a proof to the job and released it when the window closed.
 * Needs the compliance stack (packages/policy/test/helpers/stack.ts: anvil,
 * a module keyed to the prover's key, the prover); skipped without it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const proverUrl = process.env["PROVER_URL"] ?? "http://127.0.0.1:3003";
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
  if ((await json(`${proverUrl}/health`) as { status?: string } | null)?.status !== "healthy") return `no healthy prover at ${proverUrl}`;
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
    const policyFile = join(mkdtempSync(join(tmpdir(), "square-policy-")), "policy.json");
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
        SQUARE_PROVER_URL: proverUrl,
        SQUARE_COMPLIANCE_INTERVAL_MS: "2000",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    client = new Client({ name: "claude-desktop-stand-in", version: "0" });
    await client.connect(transport);
  }, 120_000);

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

  it("hires, sees the proof bound and current, and after the window the provider holds the whole net", async () => {
    const owedBefore = await provider.withdrawable(account(2).address);

    const hired = await call("square_hire", { agent: agentUrl, capability: "text.summarize", input: "one two three four five" });
    expect(hired.isError, textOf(hired)).toBeFalsy();
    expect(textOf(hired)).toMatch(/keeps the job's compliance proof current/);
    const jobId = (hired.structuredContent as { jobId: string }).jobId;
    expect(hired.structuredContent).toMatchObject({ task: { state: "DELIVERED" } });

    // The duty binds a proof for the release as it stands: this provider, this net, today's counter.
    const bound = await until(
      () => call("square_job", { jobId }),
      (result) => (result.structuredContent as { compliance?: { proof?: string } }).compliance?.proof === "current",
      "the proof being bound",
    );
    expect(bound.structuredContent).toMatchObject({ status: "Submitted", compliance: { proof: "current", payee: account(2).address } });
    const net = await institution.netPayout(BigInt(jobId));

    // The window closes; the duty rebinds for the new clock and cranks, and the module verifies.
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
    expect(stderr).toContain(`job ${jobId}: released in 0x`);
    expect(stderr).toContain(`, ${formatUnits(net, 6)} USDC to ${account(2).address}`);
    expect((await provider.withdrawable(account(2).address)) - owedBefore).toBe(net);
    // The counter moved by this release on the day the release fell in (the warp crossed midnight).
    expect(await institution.spentToday(account(1).address)).toBeGreaterThanOrEqual(net);
    const settled = await call("square_job", { jobId });
    expect(settled.structuredContent).toMatchObject({ status: "Completed" });
    expect((settled.structuredContent as { compliance?: unknown }).compliance).toBeUndefined();
  }, 300_000);
});
