import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { A2AClient, WellKnownCache } from "@squaresdk/a2a";
import { createAgent } from "@squaresdk/agent";
import { hashDeliverable, JobStatus, type SquareWalletClient } from "@squaresdk/core";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { parseUnits, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSquareMcpServer, type SquareMcpServerOptions } from "../src/server.js";
import { fakeAgent, fakeChain, fetchRouting } from "./helpers/fakeChain.js";
import { CHAIN_ID, WALLET, card, deployment, didOf, resolution, resolverOf } from "./helpers/fakes.js";

/**
 * The Square MCP server as an MCP client sees it, over the SDK's in-memory
 * transport: the same initialize, tools/list and tools/call a desktop
 * client sends over stdio. The chain is a Map and the agent is a Hono app
 * behind an A2AServer; the real ones are test/anvil.test.ts.
 */
const ATLAS = didOf(7);
const ORIGIN = "https://atlas.example";
const now = () => 1_800_000_000_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect(options: SquareMcpServerOptions): Promise<Client> {
  const server = createSquareMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "desktop", version: "0" });
  await client.connect(clientSide);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const callTool = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** The whole stage: a chain, an agent on it, a resolver that knows the agent, and a server that pays. */
function stage(options: { balance?: bigint; horizon?: number; minimum?: (capability: string) => bigint | undefined; deactivated?: boolean; wallet?: boolean; now?: () => number } = {}) {
  const chain = fakeChain({ balance: options.balance, horizon: options.horizon, now: options.now ?? (() => Math.floor(now() / 1000)), wallet: options.wallet });
  const seen: string[] = [];
  const agent = fakeAgent({
    card: card({ agentId: 7n, capabilities: [{ id: "text.summarize", description: "Summarise a document.", price: "0.05" }, { id: "free.echo", description: "Echoes." }] }),
    provider: WALLET,
    agentId: 7n,
    chain,
    minimum: options.minimum,
    handlers: {
      "text.summarize": async ({ input, jobId }) => {
        seen.push(input);
        if (input === "fail") throw new Error("the document is empty");
        if (input.startsWith("sleep ")) await new Promise((r) => setTimeout(r, Number(input.slice(6))));
        return `${input.split(" ").length} words for job ${jobId}`;
      },
      "free.echo": async ({ input }) => input,
    },
  });
  const fetch = fetchRouting({ [ORIGIN]: agent.app });
  const resolver = resolverOf({ [ATLAS]: resolution(ATLAS, { wallet: WALLET, services: [{ name: "A2A", endpoint: `${ORIGIN}/a2a` }], deactivated: options.deactivated }) });
  const serverOptions: SquareMcpServerOptions = {
    client: chain.client,
    resolver,
    a2a: new A2AClient({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }),
    cards: new WellKnownCache({ fetch }),
    pollIntervalMs: 5,
  };
  return { chain, agent, seen, serverOptions };
}

describe("what the server offers", () => {
  it("without a wallet, the three reads and nothing that spends", async () => {
    const { serverOptions } = stage({ wallet: false });
    const client = await connect(serverOptions);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["square_agent", "square_job", "square_task"]);
    expect(client.getInstructions()).toContain("No wallet is configured");
  });

  it("with a wallet, hiring too, and paying per call only with x402 configured", async () => {
    const { serverOptions } = stage();
    const client = await connect(serverOptions);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["square_agent", "square_dispatch", "square_hire", "square_job", "square_refund", "square_task"]);
    expect(client.getInstructions()).toContain(`Paying wallet: ${serverOptions.client.account}`);
    const hire = (await client.listTools()).tools.find((t) => t.name === "square_hire");
    expect(hire?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(hire?.inputSchema).toMatchObject({ required: ["agent", "capability", "input"] });
  });
});

describe("square_agent and square_job", () => {
  it("describes the agent as the chain and its card have it", async () => {
    const { serverOptions } = stage();
    const client = await connect(serverOptions);
    const result = await callTool(client, "square_agent", { agent: ATLAS });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      did: ATLAS,
      agentId: "7",
      provider: WALLET,
      name: "Atlas",
      a2aEndpoint: `${ORIGIN}/a2a`,
      x402Support: false,
      capabilities: [
        { id: "text.summarize", price: "0.05" },
        { id: "free.echo" },
      ],
      warnings: [],
    });
    expect(textOf(result)).toContain("text.summarize (0.05 USDC): Summarise a document.");
    expect(textOf(result)).toContain("free.echo (unpriced): Echoes.");
  });

  it("answers a lookup that fails as an error the model can read, and a job that does not exist likewise", async () => {
    const { serverOptions } = stage();
    const client = await connect(serverOptions);
    const unknown = await callTool(client, "square_agent", { agent: didOf(8) });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/did not resolve: notFound/);
    const job = await callTool(client, "square_job", { jobId: "99" });
    expect(job.isError).toBe(true);
    expect(textOf(job)).toMatch(/job 99 could not be read: InvalidJob\(\)/);
    const bad = await callTool(client, "square_job", { jobId: "x" });
    expect(bad.isError).toBe(true);
  });
});

describe("square_hire", () => {
  it("creates, budgets and funds the job for the agent's wallet, dispatches the task, and returns what went on chain", async () => {
    const { chain, seen, serverOptions } = stage();
    const client = await connect(serverOptions);
    const result = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "one two three" });
    expect(result.isError).toBeFalsy();
    const expiredAt = BigInt(Math.floor(now() / 1000) + 7 * 86_400);
    expect(chain.writes).toEqual([
      `createJob(1, provider=${WALLET}, expiredAt=${expiredAt})`,
      "setBudget(1, 50000)",
      "fund(1, 50000)",
      `submit(1, ${hashDeliverable("3 words for job 1")})`,
    ]);
    expect(seen).toEqual(["one two three"]);
    expect(result.structuredContent).toEqual({
      jobId: "1",
      taskId: "square-job-1",
      agent: ATLAS,
      provider: WALLET,
      capability: "text.summarize",
      budget: "0.05",
      transactions: { createJob: expect.stringMatching(/^0x/), setBudget: expect.stringMatching(/^0x/), fund: expect.stringMatching(/^0x/) },
      task: { taskId: "square-job-1", state: "DELIVERED", deliverable: hashDeliverable("3 words for job 1"), reference: expect.stringMatching(/^0x/), updatedAt: expect.any(String) },
      job: { status: "Submitted" },
    });
    const text = textOf(result);
    expect(text).toContain(`Job 1 funded with 0.05 USDC for Atlas, capability text.summarize.`);
    expect(text).toContain("Task square-job-1: DELIVERED; job Submitted on chain");
    expect(text).toContain("The evaluator settles the escrow next");
    expect(chain.state.balance).toBe(1_000_000_000n - 50_000n);

    // The job reads back the way the chain has it, bound to the agent.
    const job = await callTool(client, "square_job", { jobId: "1" });
    expect(job.structuredContent).toMatchObject({ jobId: "1", status: "Submitted", provider: WALLET, budget: "0.05", deliverable: hashDeliverable("3 words for job 1"), agentId: "7" });
    expect(job.structuredContent).toMatchObject({ expiredAt: new Date(Number(expiredAt) * 1000).toISOString() });
    // And the task, at the agent.
    const task = await callTool(client, "square_task", { agent: ATLAS, taskId: "square-job-1" });
    expect(task.structuredContent).toMatchObject({ task: { state: "DELIVERED" }, job: { status: "Submitted" } });
  });

  it("takes a budget above the price and a shorter expiry, and spends nothing when it will not hire", async () => {
    const { chain, serverOptions } = stage({ balance: 120_000n });
    const client = await connect(serverOptions);
    const priced = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b", budget: "0.10", expiresInDays: 5 });
    expect(priced.isError).toBeFalsy();
    expect(chain.writes.slice(0, 3)).toEqual([
      `createJob(1, provider=${WALLET}, expiredAt=${Math.floor(now() / 1000) + 5 * 86_400})`,
      "setBudget(1, 100000)",
      "fund(1, 100000)",
    ]);
    const before = chain.writes.length;

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ agent: ATLAS, capability: "text.summarize", input: "x", budget: "0.01" }, /budget 0.01 is below the price of text.summarize, 0.05 USDC/],
      [{ agent: ATLAS, capability: "nope", input: "x" }, /Atlas does not offer nope; it offers text.summarize, free.echo/],
      [{ agent: ATLAS, capability: "free.echo", input: "x" }, /free.echo has no price on the card; pass budget/],
      [{ agent: ATLAS, capability: "text.summarize", input: "x" }, /the wallet holds 0.02 USDC; the job needs 0.05/],
      [{ agent: ATLAS, capability: "free.echo", input: "x", budget: "0.02", expiresInDays: 1 }, /expiresInDays must be at least 5: the agent's submit needs the settlement horizon \(97 h\)/],
      [{ agent: ATLAS, capability: "free.echo", input: "x", budget: "0" }, /budget must be above zero/],
    ];
    for (const [args, message] of cases) {
      const result = await callTool(client, "square_hire", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toMatch(message);
    }
    expect(chain.writes).toHaveLength(before);
  });

  it("will not hire a deactivated agent", async () => {
    const { chain, serverOptions } = stage({ deactivated: true });
    const client = await connect(serverOptions);
    const result = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`${ATLAS} is deactivated`);
    expect(chain.writes).toEqual([]);
  });

  it("reports a task the agent refused with the job that now holds the escrow", async () => {
    const { chain, serverOptions } = stage({ minimum: () => parseUnits("1.00", 6) });
    const client = await connect(serverOptions);
    const result = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Job 1 funded with 0.05 USDC for Atlas");
    expect(textOf(result)).toContain("The task could not be handed to the agent. The escrow stays on job 1: try again later with square_dispatch");
    expect(textOf(result)).toContain("task/create rejected: job 1 is funded with 50000 but text.summarize costs 1000000");
    expect(result.structuredContent).toMatchObject({ jobId: "1", taskId: "square-job-1", transactions: { fund: expect.any(String) } });
    expect(chain.writes).toHaveLength(3);
  });

  it("reports a task that failed, with the reason and the job", async () => {
    const { serverOptions } = stage();
    const client = await connect(serverOptions);
    const result = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "fail" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Task square-job-1: FAILED; job Funded on chain\nreason: the document is empty");
    expect(textOf(result)).toContain("once the job expires, square_refund takes it back to this wallet");
    expect(result.structuredContent).toMatchObject({ jobId: "1", task: { state: "FAILED", reason: "the document is empty" }, job: { status: "Funded" } });
  });

  it("hands back the ids to poll with when the task outlives the wait, and square_task finds it delivered later", async () => {
    const { serverOptions } = stage();
    const client = await connect({ ...serverOptions, taskTimeoutMs: 40 });
    const result = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "sleep 150" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Task square-job-1 is still running after 0 s. Poll it with square_task");
    expect(result.structuredContent).toMatchObject({ jobId: "1", taskId: "square-job-1", task: { state: "WORKING" } });
    await new Promise((r) => setTimeout(r, 250));
    const task = await callTool(client, "square_task", { agent: ATLAS, taskId: "square-job-1" });
    expect(task.structuredContent).toMatchObject({ task: { state: "DELIVERED", deliverable: hashDeliverable("2 words for job 1") }, job: { status: "Submitted" } });
  });

  it("hires one job at a time, so two calls from the model do not race the wallet's nonce", async () => {
    const { chain, serverOptions } = stage();
    const client = await connect(serverOptions);
    const [a, b] = await Promise.all([
      callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "first" }),
      callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "second" }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    // Every write of job 1 precedes every write of job 2.
    const jobOf = (write: string) => Number(/\((\d+)/.exec(write)?.[1]);
    expect(chain.writes.map(jobOf)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });
});

describe("square_dispatch and square_refund (square#351)", () => {
  it("hands a funded job's task to the agent again, under the same task id, and spends nothing", async () => {
    const { chain, serverOptions, seen } = stage({ minimum: () => parseUnits("1.00", 6) });
    const client = await connect(serverOptions);
    // The agent refused the task at 0.05 (its floor is 1.00): the job is Funded and undispatched.
    const hired = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b c" });
    expect(hired.isError).toBe(true);
    expect(chain.records.get(1n)?.status).toBe(JobStatus.Funded);
    const writes = chain.writes.length;
    // The agent lowers its floor; the same job is handed over again.
    const again = await callTool(client, "square_dispatch", { agent: ATLAS, jobId: "1", capability: "text.summarize", input: "a b c" });
    expect(again.isError).toBe(true); // still refused: the stage's floor is fixed
    expect(textOf(again)).toContain("try again later with square_dispatch");
    expect(chain.writes.length).toBe(writes);
    expect(seen).toEqual([]);

    const easy = stage();
    const easyClient = await connect(easy.serverOptions);
    // A funded job nobody dispatched: created through the same chain by hand.
    await easy.chain.client.createJob({ provider: WALLET, expiredAt: BigInt(Math.floor(now() / 1000) + 86_400 * 7), spec: {} });
    await easy.chain.client.setBudget(1n, parseUnits("0.05", 6));
    await easy.chain.client.fund(1n, parseUnits("0.05", 6));
    const handed = await callTool(easyClient, "square_dispatch", { agent: ATLAS, jobId: "1", capability: "text.summarize", input: "a b c" });
    expect(handed.isError).toBeFalsy();
    expect(textOf(handed)).toContain("Job 1 (0.05 USDC in escrow) handed to Atlas again.");
    expect(handed.structuredContent).toMatchObject({ jobId: "1", taskId: "square-job-1", task: { state: "DELIVERED" } });
    expect(easy.chain.records.get(1n)?.status).toBe(JobStatus.Submitted);

    // Not an Open job, not somebody else's.
    await easy.chain.client.createJob({ provider: WALLET, expiredAt: BigInt(Math.floor(now() / 1000) + 86_400 * 7), spec: {} });
    const open = await callTool(easyClient, "square_dispatch", { agent: ATLAS, jobId: "2", capability: "text.summarize", input: "x" });
    expect(open.isError).toBe(true);
    expect(textOf(open)).toContain("job 2 is Open, not Funded");
  });

  it("says when an escrow becomes claimable, and after the expiry claims and withdraws it", async () => {
    const clock = { now: Math.floor(now() / 1000) };
    const { chain, serverOptions } = stage({ minimum: () => parseUnits("1.00", 6), now: () => clock.now });
    const client = await connect(serverOptions);
    const hired = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b c", expiresInDays: 7 });
    expect(hired.isError).toBe(true);
    const before = await callTool(client, "square_refund", { jobId: "1" });
    expect(before.isError).toBeFalsy();
    expect(textOf(before)).toContain("Job 1 is Funded and expires");
    expect(before.structuredContent).toMatchObject({ claimable: false, budget: "0.05" });
    const balance = chain.state.balance;

    clock.now += 8 * 86_400;
    const after = await callTool(client, "square_refund", { jobId: "1" });
    expect(after.isError).toBeFalsy();
    expect(textOf(after)).toMatch(/refund claimed in 0x[0-9a-f]+ and withdrawn to/);
    expect(after.structuredContent).toMatchObject({ status: "Expired", transactions: { claimRefund: expect.any(String), withdraw: expect.any(String) } });
    expect(chain.writes.slice(-2)).toEqual(["claimRefund(1)", `withdraw(${parseUnits("0.05", 6)})`]);
    expect(chain.state.balance).toBe(balance + parseUnits("0.05", 6));

    const settled = await callTool(client, "square_refund", { jobId: "1" });
    expect(settled.isError).toBe(true);
    expect(textOf(settled)).toContain("job 1 is Expired; the escrow has already been settled");
    await chain.client.createJob({ provider: WALLET, expiredAt: BigInt(clock.now + 86_400 * 7), spec: {} });
    const open = await callTool(client, "square_refund", { jobId: "2" });
    expect(open.isError).toBeFalsy();
    expect(textOf(open)).toContain("Job 2 is Open: nothing is escrowed on it");
  });

  it("square_hire carries on with the Open job a failed funding left, when told its id", async () => {
    const { chain, serverOptions } = stage({ balance: 0n });
    const client = await connect(serverOptions);
    const short = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b c" });
    expect(short.isError).toBe(true);
    expect(textOf(short)).toContain("the wallet holds 0 USDC");
    expect(chain.records.size).toBe(0);
    // A funding that fails after the job is open leaves it Open: the answer names the way back.
    chain.state.balance = parseUnits("0.05", 6);
    const fund = chain.client.fund;
    chain.client.fund = async () => {
      throw new Error("ERC20InsufficientBalance");
    };
    const half = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b c" });
    expect(half.isError).toBe(true);
    expect(half.structuredContent).toMatchObject({ transactions: { createJob: expect.any(String), setBudget: expect.any(String) }, hint: expect.stringContaining("call square_hire again with its jobId") });
    chain.client.fund = fund;
    const resumed = await callTool(client, "square_hire", { agent: ATLAS, capability: "text.summarize", input: "a b c", jobId: "1" });
    expect(resumed.isError).toBeFalsy();
    expect(resumed.structuredContent).toMatchObject({ jobId: "1", task: { state: "DELIVERED" } });
    expect(chain.records.size).toBe(1);
  });
});

describe("square_call", () => {
  const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil 2
  const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil 1

  function acceptingFacilitator(): FacilitatorClient & { settled: string[] } {
    const settled: string[] = [];
    return {
      settled,
      verify: (_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> => Promise.resolve({ isValid: true, payer: payer.address } as VerifyResponse),
      settle: (_p: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
        settled.push(requirements.amount);
        return Promise.resolve({ success: true, transaction: ("0x" + "ab".repeat(32)) as Hex, network: requirements.network, payer: payer.address } as unknown as SettleResponse);
      },
      getSupported: (): Promise<SupportedResponse> =>
        Promise.resolve({ kinds: [{ x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}` }], signers: { "eip155:*": [owner.address] } } as unknown as SupportedResponse),
    };
  }

  /** A real `createAgent` with x402, its chain stubbed the way packages/agent's own tests stub it. */
  function x402Agent() {
    const publicClient = { chain: { id: CHAIN_ID }, getChainId: async () => CHAIN_ID, readContract: async () => { throw new Error("unexpected read"); } } as unknown as PublicClient;
    const walletClient = { account: owner, chain: { id: CHAIN_ID } } as unknown as SquareWalletClient;
    const facilitator = acceptingFacilitator();
    const agent = createAgent({ name: "Atlas", description: "Summarises.", walletClient, publicClient, deployment, agentId: 1n, url: ORIGIN, x402: { facilitator } })
      .capability("text.summarize", { description: "Summarise a document.", price: "0.05", handler: async ({ input }) => `${input.split(" ").length} words` })
      .capability("text.expand", { description: "Costs more.", price: "5.00", handler: async ({ input }) => input })
      .capability("free.echo", { description: "Echoes.", handler: async ({ input }) => input });
    return { agent, facilitator };
  }

  it("pays the capability's price per call and returns the output, with the settlement", async () => {
    const { agent, facilitator } = x402Agent();
    const fetch = fetchRouting({ [ORIGIN]: agent.app });
    const chain = fakeChain({ account: payer.address });
    const resolver = resolverOf({ [agent.did]: resolution(agent.did, { owner: owner.address, services: [{ name: "A2A", endpoint: `${ORIGIN}/a2a` }] }) });
    const client = await connect({
      client: chain.client,
      resolver,
      cards: new WellKnownCache({ fetch }),
      a2a: new A2AClient({ fetch }),
      x402: { account: payer, maxAmountPerPayment: "1.00", fetch },
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("square_call");

    const result = await callTool(client, "square_call", { agent: agent.did, capability: "text.summarize", input: "one two three" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toEqual({
      agent: agent.did,
      capability: "text.summarize",
      price: "0.05",
      output: "3 words",
      settlement: { transaction: "0x" + "ab".repeat(32), network: `eip155:${CHAIN_ID}` },
    });
    expect(textOf(result)).toContain("3 words\n\nPaid 0.05 USDC to Atlas (settlement 0xabab");
    expect(facilitator.settled).toEqual(["50000"]);
    expect(chain.writes).toEqual([]);

    const dear = await callTool(client, "square_call", { agent: agent.did, capability: "text.expand", input: "x" });
    expect(dear.isError).toBe(true);
    expect(textOf(dear)).toBe("text.expand costs 5.00 USDC per call, above this server's cap of 1.00");
    const free = await callTool(client, "square_call", { agent: agent.did, capability: "free.echo", input: "x" });
    expect(textOf(free)).toBe("free.echo is not priced per call");
    expect(facilitator.settled).toEqual(["50000"]);
  });

  it("sends a caller to square_hire when the agent does not serve x402", async () => {
    const { serverOptions } = stage();
    const client = await connect({ ...serverOptions, x402: { account: payer, maxAmountPerPayment: "1.00" } });
    const result = await callTool(client, "square_call", { agent: ATLAS, capability: "text.summarize", input: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Atlas does not serve x402; hire it with square_hire instead");
  });
});
