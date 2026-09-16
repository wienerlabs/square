import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent, type Agent, type Listening } from "@squaresdk/agent";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { hostAgent, type HostedAgent } from "../src/host.js";
import type { HostedAgentConfig } from "../src/config.js";
import { deriveSealKey, open } from "../src/sealed.js";
import { scriptedModel, type Step } from "./helpers/scriptedModel.js";

/**
 * The acceptance criteria of square#38 on a local chain. A hosted agent
 * (anvil account 2, agent 1) takes a funded job and completes it; the
 * model behind its capability delegates a subtask to another agent (anvil
 * account 3, agent 2), which is hired under escrow from the hosted wallet
 * and counted against the policy that wallet committed on chain; a second
 * delegation past the allowance is refused before any escrow moves. The
 * model is scripted: what is under test is the loop, the escrow and the
 * allowance, not the model's judgement. Needs anvil with DeployLocal.s.sol
 * on it and the package built (the binary is smoke-tested); skipped
 * without the chain, the way packages/agent's suite is.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const DEPLOYMENT_FILE = join(HERE, "..", "..", "..", "contracts", "deployments", "31337.json");
const BIN = join(HERE, "..", "dist", "bin.js");
const COMMITMENT = `0x${"00".repeat(31)}2a` as const;

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

describe.skipIf(!reachable)("a hosted agent takes a job, delegates a subtask under its policy, and is refused past it", () => {
  const deployment = localDeployment();
  // Anvil mines per transaction; viem's default four-second receipt poll would be most of this suite's wall clock.
  const pollingInterval = 500;
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index), pollingInterval });
  const hirer = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const cranker = createSquareClient({ publicClient, deployment, walletClient: wallet(3) });
  const CALLER = `did:aip:eip155:31337:${deployment.identityRegistry.toLowerCase()}:9`;

  let scribe: Agent;
  let scribeListening: Listening;
  let scribeUrl: string;
  let hosted: HostedAgent;
  let hostedListening: Listening;
  let hostedUrl: string;
  const delivered: string[] = [];
  const scribeSaw: string[] = [];
  let hostedJob: bigint;

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} is not built; run npm run build first`);

    // Agent 2 for anvil account 3: DeployLocal seeds only agent 1, and the mock registry lets anyone set the rest.
    await wallet(0).writeContract({
      address: deployment.identityRegistry,
      abi: [{ type: "function", name: "setAgent", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "owner", type: "address" }, { name: "wallet", type: "address" }], outputs: [] }],
      functionName: "setAgent",
      args: [2n, account(3).address, account(3).address],
    });

    const scribePort = await freePort();
    scribeUrl = `http://127.0.0.1:${scribePort}`;
    scribe = createAgent({
      name: "Scribe",
      description: "Summarises what it is given.",
      walletClient: wallet(3),
      publicClient,
      deployment,
      agentId: 2n,
      url: scribeUrl,
    }).capability("text.summarize", {
      description: "Summarise a document.",
      price: "0.10",
      handler: async ({ input }) => {
        scribeSaw.push(input);
        return `${input.split(/\s+/).length} words`;
      },
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
    };
    // The script: delegate the summary, then answer with what came back;
    // the second task asks for more than the allowance has left.
    const steps: Step[] = [
      { tools: [{ name: "delegate", input: { agent: scribeUrl, capability: "text.summarize", input: "one two three four" } }] },
      (request) => {
        const results = request.messages[request.messages.length - 1]!.content as Array<{ content: string }>;
        const job = /job (\d+) funded/.exec(results[0]!.content)?.[1];
        return { text: `Brief: four words, per Scribe (job ${job}).` };
      },
      { tools: [{ name: "delegate", input: { agent: scribeUrl, capability: "text.summarize", input: "five six", budget: "0.45" } }] },
      (request) => {
        const results = request.messages[request.messages.length - 1]!.content as Array<{ content: string; is_error?: boolean }>;
        return { text: results[0]!.is_error ? `Could not delegate: ${results[0]!.content}` : "unexpectedly delegated" };
      },
    ];
    hosted = await hostAgent(config, {
      walletClient: wallet(2),
      publicClient,
      deployment,
      rpcUrl,
      anthropic: () => scriptedModel(steps),
      pollIntervalMs: 200,
      onRun: ({ outcome }) => delivered.push(outcome.text),
    });
    // The hosted wallet commits the policy its delegations are measured against.
    await hosted.agent.client.setPolicy(COMMITMENT, parseUnits("0.50", 6));
    hostedListening = await hosted.agent.listen(hostedPort, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await hostedListening?.close();
    await scribeListening?.close();
    await hosted?.close();
  });

  const rpc = async (url: string, method: string, params: unknown) => {
    const response = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };

  async function untilTerminal(url: string, taskId: string) {
    for (let i = 0; i < 600; i += 1) {
      const res = await rpc(url, "task/status", { taskId });
      if (res.result && res.result["state"] !== "WORKING") return res.result;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("task never left WORKING");
  }

  async function fundedJob(budget: bigint): Promise<bigint> {
    const block = await publicClient.getBlock();
    const { jobId } = await hirer.createJob({ provider: hosted.agent.address, expiredAt: block.timestamp + 10n * 86_400n, spec: { task: "brief" } });
    await hirer.setBudget(jobId, budget);
    await hirer.fund(jobId, budget);
    return jobId;
  }

  it("serves the card from the config, and the allowance reads the policy off the chain", async () => {
    const card = (await (await fetch(`${hostedUrl}/.well-known/agent-registration.json`)).json()) as { name: string; "x-aip": { capabilities: Array<{ id: string }> } };
    expect(card.name).toBe("Acme Research");
    expect(card["x-aip"].capabilities.map((c) => c.id)).toEqual(["research.brief"]);
    expect(await hosted.allowance!.view()).toMatchObject({ policy: true, dailyLimit: parseUnits("0.50", 6), inFlight: 0n, available: parseUnits("0.50", 6) });
  }, 30_000);

  it("takes a funded job, hires Scribe under escrow from its own wallet for the subtask, and delivers", async () => {
    hostedJob = await fundedJob(parseUnits("0.50", 6));
    const scribeBefore = await scribe.client.usdcBalance(account(3).address);
    const hostedBefore = await hosted.agent.client.usdcBalance(account(2).address);
    const created = await rpc(hostedUrl, "task/create", { taskId: "brief-1", capability: "research.brief", input: "Brief me", callerDid: CALLER, jobId: hostedJob.toString() });
    expect(created.result, JSON.stringify(created)).toMatchObject({ state: "WORKING" });
    const done = await untilTerminal(hostedUrl, "brief-1");
    expect(done, JSON.stringify(done)).toMatchObject({ state: "DELIVERED", job: { status: JobStatus.Submitted } });

    // What the hosted agent delivered is the model's text, hashed on chain.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^Brief: four words, per Scribe \(job \d+\)\.$/);
    expect(done["deliverable"]).toBe(hashDeliverable(delivered[0]!));
    expect((await hirer.getJobRecord(hostedJob)).status).toBe(JobStatus.Submitted);
    expect(await hirer.agentOf(hostedJob)).toBe(1n);

    // The subtask was a job of its own: hosted wallet as client, Scribe as provider, bound to agent 2, in flight on the allowance.
    const subJob = BigInt(/job (\d+)/.exec(delivered[0]!)![1]!);
    const record = await hirer.getJobRecord(subJob);
    expect(record.client).toBe(account(2).address);
    expect(record.provider).toBe(account(3).address);
    expect(record.budget).toBe(parseUnits("0.10", 6));
    expect(record.status).toBe(JobStatus.Submitted);
    expect(record.deliverable).toBe(hashDeliverable("4 words"));
    expect(await hirer.agentOf(subJob)).toBe(2n);
    expect(scribeSaw).toEqual(["one two three four"]);
    expect(hostedBefore - (await hosted.agent.client.usdcBalance(account(2).address))).toBe(parseUnits("0.10", 6));
    expect(await scribe.client.usdcBalance(account(3).address)).toBe(scribeBefore);
    expect(await hosted.allowance!.view()).toMatchObject({ inFlight: parseUnits("0.10", 6), available: parseUnits("0.40", 6) });
    expect(hosted.allowance!.inFlightJobs()).toEqual([{ jobId: subJob, budget: parseUnits("0.10", 6) }]);
  }, 180_000);

  it("refuses a delegation past the allowance before any escrow moves, and still delivers what the model says", async () => {
    const job = await fundedJob(parseUnits("0.50", 6));
    const counter = await hirer.jobCounter();
    const hostedBefore = await hosted.agent.client.usdcBalance(account(2).address);
    await rpc(hostedUrl, "task/create", { taskId: "brief-2", capability: "research.brief", input: "Brief me again", callerDid: CALLER, jobId: job.toString() });
    const done = await untilTerminal(hostedUrl, "brief-2");
    expect(done).toMatchObject({ state: "DELIVERED" });
    expect(delivered[1]).toMatch(/^Could not delegate: 0.45 USDC is more than the policy allows today: ceiling 0.5, 0 released today, 0.1 in flight on 1 job\(s\), 0.4 available\. Nothing was spent\.$/);
    expect(await hirer.jobCounter()).toBe(counter);
    expect(await hosted.agent.client.usdcBalance(account(2).address)).toBe(hostedBefore);
    expect(scribeSaw).toHaveLength(1);
  }, 180_000);

  it("drops the subtask from flight once the crank settles it", async () => {
    const [inFlight] = hosted.allowance!.inFlightJobs();
    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    await cranker.finalize(inFlight!.jobId);
    expect((await hirer.getJobRecord(inFlight!.jobId)).status).toBe(JobStatus.Completed);
    const view = await hosted.allowance!.view();
    expect(view.inFlight).toBe(0n);
    // The registry counts a release only through the compliance module, which the local stack does not install; the allowance reads whatever it says.
    expect(view.available).toBe(view.dailyLimit - view.spentToday);
    expect(hosted.allowance!.inFlightJobs()).toEqual([]);
  }, 120_000);

  describe("the square-hosted binary", () => {
    let child: ChildProcess | undefined;
    afterAll(() => {
      child?.kill("SIGTERM");
    });

    it("seals a key for an agent, and runs a configuration up to the card without a model call", async () => {
      const secret = "the platform's seal secret";
      const sealed = await new Promise<string>((resolve, reject) => {
        const proc = spawn(process.execPath, [BIN, "seal", "1"], { env: { ...process.env, SQUARE_SEAL_SECRET: secret }, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        proc.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`seal exited ${code}`))));
        proc.stdin.end("sk-ant-own\n");
      });
      expect(open(sealed, deriveSealKey(secret), "hosted-agent:1")).toBe("sk-ant-own");

      const port = await freePort();
      const dir = mkdtempSync(join(tmpdir(), "square-hosted-"));
      const file = join(dir, "acme.json");
      writeFileSync(
        file,
        JSON.stringify({
          name: "Acme Research",
          description: "Briefs.",
          agentId: "1",
          url: `http://127.0.0.1:${port}`,
          provider: { tier: "own", apiKey: sealed },
          capabilities: [{ id: "research.brief", description: "A brief.", price: "0.50", instructions: "Write a brief." }],
        }),
      );
      child = spawn(process.execPath, [BIN, file], {
        env: {
          ...process.env,
          SQUARE_CHAIN_ID: "31337",
          SQUARE_RPC_URL: rpcUrl,
          SQUARE_DEPLOYMENT_FILE: DEPLOYMENT_FILE,
          SQUARE_PRIVATE_KEY: `0x${Buffer.from(account(2).getHdKey().privateKey!).toString("hex")}`,
          SQUARE_SEAL_SECRET: secret,
          PORT: String(port),
          HOST: "127.0.0.1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const banner = await new Promise<string>((resolve, reject) => {
        let err = "";
        child!.stderr!.on("data", (chunk: Buffer) => {
          err += chunk.toString();
          if (err.includes("listening at")) resolve(err);
        });
        child!.on("exit", (code) => reject(new Error(`square-hosted exited ${code}: ${err}`)));
      });
      expect(banner).toContain("Acme Research (did:aip:eip155:31337:");
      expect(banner).toContain("research.brief; own key; no MCP tools; no delegation");
      const card = (await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-registration.json`)).json()) as { name: string };
      expect(card.name).toBe("Acme Research");
    }, 60_000);

    // square#336: a host with variables and no file to mount hands the
    // configuration over in SQUARE_HOSTED_CONFIG and gives no path.
    let fromEnv: ChildProcess | undefined;
    afterAll(() => {
      fromEnv?.kill("SIGTERM");
    });
    it("runs the same configuration from SQUARE_HOSTED_CONFIG when no path is given", async () => {
      const port = await freePort();
      fromEnv = spawn(process.execPath, [BIN], {
        env: {
          ...process.env,
          SQUARE_HOSTED_CONFIG: JSON.stringify({
            name: "Acme From Env",
            description: "Briefs.",
            agentId: "1",
            url: `http://127.0.0.1:${port}`,
            provider: { tier: "platform" },
            capabilities: [{ id: "research.brief", description: "A brief.", price: "0.50", instructions: "Write a brief." }],
          }),
          SQUARE_CHAIN_ID: "31337",
          SQUARE_RPC_URL: rpcUrl,
          SQUARE_DEPLOYMENT_FILE: DEPLOYMENT_FILE,
          SQUARE_PRIVATE_KEY: `0x${Buffer.from(account(2).getHdKey().privateKey!).toString("hex")}`,
          PORT: String(port),
          HOST: "127.0.0.1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const banner = await new Promise<string>((resolve, reject) => {
        let err = "";
        fromEnv!.stderr!.on("data", (chunk: Buffer) => {
          err += chunk.toString();
          if (err.includes("listening at")) resolve(err);
        });
        fromEnv!.on("exit", (code) => reject(new Error(`square-hosted exited ${code}: ${err}`)));
      });
      expect(banner).toContain("Acme From Env (did:aip:eip155:31337:");
      expect(banner).toContain("platform key");
      const card = (await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-registration.json`)).json()) as { name: string };
      expect(card.name).toBe("Acme From Env");
    }, 60_000);
  });
});
