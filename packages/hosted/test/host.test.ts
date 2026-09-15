import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A2AClient } from "@squaresdk/a2a";
import type { CapabilityOptions } from "@squaresdk/agent";
import { hashDeliverable, JobStatus, type SquareWalletClient } from "@squaresdk/core";
import { ToolPool } from "@squaresdk/mcp";
import { parseUnits, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type Anthropic from "@anthropic-ai/sdk";
import type { HostedAgentConfig } from "../src/config.js";
import type { DelegationDeps } from "../src/delegation.js";
import { newPolicy, type DutyEvent, type TrackedJob } from "@squaresdk/policy";
import { hostAgent, hostedHandlers, sealContext, type HandlerContext } from "../src/host.js";
import { deriveSealKey, seal } from "../src/sealed.js";
import { CHAIN_ID, card, cardsOver, deployment, didOf, fakeAgent, fakeSquare, fetchRouting, HOST_WALLET, resolution, resolverOf, SUB_WALLET } from "./helpers/fakeSquare.js";
import { scriptedModel, type Step } from "./helpers/scriptedModel.js";
import { startToolServer, type ToolServer } from "./helpers/toolServer.js";

/**
 * A hosted agent's capabilities, run without a chain: the handler each task
 * reaches once the agent's settlement admits it. The model is scripted, the
 * MCP tools are a real server over Streamable HTTP, and the agent it
 * delegates to is a Hono app over a Map of a chain. The real chain is
 * test/anvil.test.ts.
 */
const SCRIBE = "https://scribe.example";
const SCRIBE_DID = didOf(2);
const COMMITMENT = `0x${"00".repeat(31)}2a` as const;
const usdc = (n: string) => parseUnits(n, 6);

const config: HostedAgentConfig = {
  name: "Acme Research",
  description: "Briefs, with sources.",
  agentId: "1",
  url: "https://research.acme.example",
  provider: { tier: "platform" },
  capabilities: [
    { id: "research.brief", description: "A brief.", price: "0.50", instructions: "Write a brief.", delegate: true },
    { id: "weather.brief", description: "The weather, in a sentence.", price: "0.05", instructions: "Say the weather.", delegate: false },
    { id: "plain.echo", description: "Echoes.", instructions: "Echo.", tools: false },
  ],
  delegation: { allow: [SCRIBE], maxPerJob: "0.25" },
};

const named = (tools: Anthropic.MessageCreateParamsNonStreaming["tools"]) =>
  (tools ?? []).filter((t): t is Anthropic.Tool => "input_schema" in t).map((t) => t.name);

const call = (options: CapabilityOptions, input: string) =>
  options.handler({ input, taskId: "t1", capability: "c", jobId: "9", callerDid: "did:x", signal: new AbortController().signal });

describe("hostedHandlers", () => {
  let weather: ToolServer;
  let tools: ToolPool;
  beforeAll(async () => {
    weather = await startToolServer({ name: "weather" });
    tools = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache: false });
  });
  afterAll(async () => {
    await tools.close();
    await weather.close();
  });

  /** The stage for delegation: the hosted wallet's chain, the Scribe agent on it, and the lookups that find it. */
  function stage(steps: Step[], options: { policy?: string | undefined; resolveDeliverable?: DelegationDeps["resolveDeliverable"] } = {}) {
    const chain = fakeSquare({ account: HOST_WALLET });
    const seen: string[] = [];
    const scribe = fakeAgent({
      card: card(),
      provider: SUB_WALLET,
      agentId: 2n,
      chain,
      handlers: {
        "text.summarize": async ({ input }) => {
          seen.push(input);
          if (input === "fail") throw new Error("nothing to summarise");
          return `${input.split(" ").length} words`;
        },
      },
    });
    const fetch = fetchRouting({ [SCRIBE]: scribe.app });
    const model = scriptedModel(steps);
    const runs: Array<{ capability: string; turns: number }> = [];
    const context: HandlerContext = {
      model,
      modelName: "claude-opus-5",
      tools,
      delegation: {
        client: chain.client,
        a2a: new A2AClient({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }),
        resolver: resolverOf({ [SCRIBE_DID]: resolution(SCRIBE_DID, SUB_WALLET, `${SCRIBE}/a2a`) }),
        cards: cardsOver(fetch),
        allowance: new (class extends Object {})() as never,
        allow: config.delegation!.allow,
        callerDid: didOf(1),
        pollIntervalMs: 5,
        resolveDeliverable: options.resolveDeliverable,
      },
      onRun: ({ capability, outcome }) => runs.push({ capability, turns: outcome.turns }),
    };
    return { chain, model, seen, runs, context };
  }

  it("delivers the model's text; a capability without tools is asked without any", async () => {
    const { model, runs, context } = stage([{ text: "echo: hi" }]);
    const handlers = hostedHandlers(config, context);
    expect([...handlers.keys()]).toEqual(["research.brief", "weather.brief", "plain.echo"]);
    expect(handlers.get("research.brief")).toMatchObject({ description: "A brief.", price: "0.50" });
    expect(await call(handlers.get("plain.echo")!, "hi")).toBe("echo: hi");
    expect("tools" in model.requests[0]!).toBe(false);
    expect(runs).toEqual([{ capability: "plain.echo", turns: 1 }]);
  });

  it("gives the model the MCP tools and runs the one it calls", async () => {
    const { model, context } = stage([{ tools: [{ name: "weather__forecast", input: { city: "Berlin" } }] }, { text: "Sunny in Berlin." }]);
    const handlers = hostedHandlers(config, context);
    const before = weather.calls.length;
    expect(await call(handlers.get("weather.brief")!, "Berlin")).toBe("Sunny in Berlin.");
    expect(named(model.requests[0]!.tools)).toEqual(["weather__forecast", "weather__slow", "weather__boom", "weather__big", "weather__structured"]);
    expect(weather.calls.slice(before)).toEqual([{ tool: "forecast", args: { city: "Berlin" } }]);
    expect(model.requests[1]!.messages[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", content: "Berlin: sunny" }] });
  });
});

describe("delegation from a hosted capability", () => {
  let weather: ToolServer;
  let tools: ToolPool;
  beforeAll(async () => {
    weather = await startToolServer({ name: "weather" });
    tools = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache: false });
  });
  afterAll(async () => {
    await tools.close();
    await weather.close();
  });

  async function stage(steps: Step[], options: { policy?: string; resolveDeliverable?: DelegationDeps["resolveDeliverable"] } = {}) {
    const { PolicyAllowance } = await import("../src/allowance.js");
    const chain = fakeSquare({ account: HOST_WALLET });
    if (options.policy !== undefined) await chain.client.setPolicy(COMMITMENT, usdc(options.policy));
    const seen: string[] = [];
    const scribe = fakeAgent({
      card: card(),
      provider: SUB_WALLET,
      agentId: 2n,
      chain,
      handlers: {
        "text.summarize": async ({ input }) => {
          seen.push(input);
          if (input === "fail") throw new Error("nothing to summarise");
          return `${input.split(" ").length} words`;
        },
      },
    });
    const fetch = fetchRouting({ [SCRIBE]: scribe.app });
    const model = scriptedModel(steps);
    const allowance = new PolicyAllowance({ client: chain.client, maxPerJob: usdc(config.delegation!.maxPerJob!) });
    const context: HandlerContext = {
      model,
      modelName: "claude-opus-5",
      tools,
      delegation: {
        client: chain.client,
        a2a: new A2AClient({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) }),
        resolver: resolverOf({ [SCRIBE_DID]: resolution(SCRIBE_DID, SUB_WALLET, `${SCRIBE}/a2a`) }),
        cards: cardsOver(fetch),
        allowance,
        allow: config.delegation!.allow,
        callerDid: didOf(1),
        pollIntervalMs: 5,
        resolveDeliverable: options.resolveDeliverable,
      },
    };
    const handlers = hostedHandlers(config, context);
    return { chain, model, seen, allowance, handlers };
  }

  const delegation = (input: string, budget?: string) => ({
    name: "delegate",
    input: { agent: SCRIBE, capability: "text.summarize", input, ...(budget ? { budget } : {}) },
  });

  it("hires the agent under escrow from the hosted wallet, counts it against the allowance, and tells the model the reference", async () => {
    const { chain, model, seen, allowance, handlers } = await stage(
      [{ tools: [delegation("one two three four")] }, { text: "Brief: four words, per Scribe (job 1)." }],
      { policy: "0.50" },
    );
    const text = await call(handlers.get("research.brief")!, "Brief me on four words");
    expect(text).toBe("Brief: four words, per Scribe (job 1).");
    expect(seen).toEqual(["one two three four"]);
    expect(chain.writes).toEqual([
      "setPolicy(500000)",
      `createJob(1, provider=${SUB_WALLET})`,
      "setBudget(1, 100000)",
      "fund(1, 100000)",
      `submit(1, ${hashDeliverable("4 words")})`,
    ]);
    const result = (model.requests[1]!.messages[2] as { content: Array<{ content: string; is_error?: boolean }> }).content[0]!;
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain(`Delegated to Scribe (${SCRIBE_DID}): job 1 funded with 0.1 USDC for text.summarize.`);
    expect(result.content).toContain(`Task square-job-1 DELIVERED; deliverable ${hashDeliverable("4 words")} is the hash the agent's submit put on chain`);
    expect(result.content).toContain("Job status on chain: Submitted.");
    expect(result.content).toContain("The work itself is not carried over A2A");
    expect(await allowance.view()).toMatchObject({ dailyLimit: usdc("0.50"), spentToday: 0n, inFlight: usdc("0.10"), available: usdc("0.40") });
    expect(chain.records.get(1n)).toMatchObject({ client: HOST_WALLET, provider: SUB_WALLET, status: JobStatus.Submitted });
    // The delegate tool the model was given names the allowed agents and is strict.
    const tool = model.requests[0]!.tools!.find((t): t is Anthropic.Tool => "input_schema" in t && t.name === "delegate")!;
    expect(tool).toMatchObject({ strict: true, input_schema: { required: ["agent", "capability", "input"] } });
    expect((tool as { description: string }).description).toContain(SCRIBE);
  });

  it("hands the model the content when the host can fetch it", async () => {
    const { model, handlers } = await stage(
      [{ tools: [delegation("a b")] }, { text: "done" }],
      { policy: "0.50", resolveDeliverable: async (task) => `content behind ${task.deliverable?.slice(0, 6)}` },
    );
    await call(handlers.get("research.brief")!, "x");
    const result = (model.requests[1]!.messages[2] as { content: Array<{ content: string }> }).content[0]!;
    expect(result.content).toContain(`The agent's deliverable:\ncontent behind ${hashDeliverable("2 words").slice(0, 6)}`);
  });

  it("refuses, before any escrow moves, an agent outside the allowlist, a hire past the allowance, a job above the per-job cap, and a wallet without a policy", async () => {
    const { chain, model, handlers } = await stage(
      [
        { tools: [{ name: "delegate", input: { agent: "https://stranger.example", capability: "text.summarize", input: "x" } }] },
        { tools: [delegation("x", "0.30")] },
        { tools: [delegation("x", "0.20")] },
        { text: "I could not delegate." },
      ],
      { policy: "0.15" },
    );
    expect(await call(handlers.get("research.brief")!, "x")).toBe("I could not delegate.");
    const results = model.requests.slice(1).map((r) => (r.messages[r.messages.length - 1] as { content: Array<{ content: string; is_error?: boolean }> }).content[0]!);
    expect(results.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(results[0]!.content).toBe(`https://stranger.example is not an agent this one may hire; allowed: ${SCRIBE}`);
    expect(results[1]!.content).toBe("0.3 USDC is more than one delegated job may be funded with (0.25). Nothing was spent.");
    expect(results[2]!.content).toMatch(/^0.2 USDC is more than the policy allows today: ceiling 0.15, 0 released today, 0 in flight on 0 job\(s\), 0.15 available\. Nothing was spent\.$/);
    expect(chain.writes).toEqual(["setPolicy(150000)"]);

    const bare = await stage([{ tools: [delegation("x")] }, { text: "no" }]);
    await call(bare.handlers.get("research.brief")!, "x");
    const refusal = (bare.model.requests[1]!.messages[2] as { content: Array<{ content: string }> }).content[0]!;
    expect(refusal.content).toBe(`${HOST_WALLET} has no policy on the registry, so it may delegate nothing. Nothing was spent.`);
    expect(bare.chain.writes).toEqual([]);
  });

  it("tells the model when the hired agent failed, with the job that holds the escrow, and a capability that may not delegate gets no such tool", async () => {
    const { chain, model, handlers } = await stage([{ tools: [delegation("fail")] }, { text: "Scribe failed; job 1 holds the escrow." }], { policy: "0.50" });
    await call(handlers.get("research.brief")!, "x");
    const result = (model.requests[1]!.messages[2] as { content: Array<{ content: string; is_error?: boolean }> }).content[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Task square-job-1 FAILED: nothing to summarise. The escrow stays on job 1");
    expect(chain.records.get(1n)?.status).toBe(JobStatus.Funded);

    const plain = await stage([{ tools: [delegation("x")] }, { text: "ok" }], { policy: "0.50" });
    await call(plain.handlers.get("weather.brief")!, "x");
    expect(named(plain.model.requests[0]!.tools)).not.toContain("delegate");
    const denied = (plain.model.requests[1]!.messages[2] as { content: Array<{ content: string; is_error?: boolean }> }).content[0]!;
    expect(denied).toMatchObject({ content: "this capability may not delegate", is_error: true });
    expect(plain.chain.writes).toEqual(["setPolicy(500000)"]);
  });

  it("runs two delegations of one turn one after the other, so the wallet signs one hire at a time", async () => {
    const { chain, handlers } = await stage(
      [{ tools: [delegation("a b"), delegation("c d e")] }, { text: "both" }],
      { policy: "0.50" },
    );
    expect(await call(handlers.get("research.brief")!, "x")).toBe("both");
    const jobOf = (write: string) => Number(/\((\d+)/.exec(write)?.[1]);
    expect(chain.writes.slice(1).map(jobOf)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });
});

describe("hostAgent", () => {
  const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil 2
  const publicClient = { chain: { id: CHAIN_ID }, getChainId: async () => CHAIN_ID } as unknown as PublicClient;
  const walletClient = { account: owner, chain: { id: CHAIN_ID } } as unknown as SquareWalletClient;
  const secret = "the platform's seal secret";

  it("serves the card from the config, opens an own key for its own agent only, and keeps the model's key off the card", async () => {
    const sealed = seal("sk-ant-own", deriveSealKey(secret), sealContext({ agentId: "1" }));
    const keys: Array<string | undefined> = [];
    const hosted = await hostAgent(
      { ...config, provider: { tier: "own", apiKey: sealed } },
      {
        walletClient,
        publicClient,
        deployment,
        sealSecret: secret,
        anthropic: (apiKey) => {
          keys.push(apiKey);
          return scriptedModel([]);
        },
        resolver: resolverOf({}),
      },
    );
    expect(keys).toEqual(["sk-ant-own"]);
    const served = hosted.agent.card();
    expect(served.name).toBe("Acme Research");
    expect(served["x-aip"].capabilities.map((c) => [c.id, c.pricing?.amount])).toEqual([
      ["research.brief", "0.50"],
      ["weather.brief", "0.05"],
      ["plain.echo", undefined],
    ]);
    expect(JSON.stringify(served)).not.toContain("sk-ant");
    expect(hosted.agent.did).toBe(didOf(1));
    expect(hosted.allowance).toBeDefined();
    expect(hosted.tools).toBeUndefined();
    await hosted.close();

    await expect(hostAgent({ ...config, provider: { tier: "own", apiKey: sealed } }, { walletClient, publicClient, deployment, resolver: resolverOf({}) })).rejects.toThrow(
      /brings its own key, and the host has no seal secret/,
    );
    await expect(
      hostAgent({ ...config, agentId: "2", provider: { tier: "own", apiKey: sealed } }, { walletClient, publicClient, deployment, sealSecret: secret, resolver: resolverOf({}) }),
    ).rejects.toThrow(/does not open with this key for this agent/);
  });

  it("recovers the delegated jobs a restart forgot from the duty's state, budgets and all, into the allowance (square#348)", async () => {
    const policy = newPolicy({ operator: HOST_WALLET, maxDailySpend: usdc("5"), maxPerTransaction: usdc("1"), categories: ["text.summarize"], tokens: [deployment.usdc] });
    const kept: TrackedJob[] = [
      { jobId: 4n, category: "text.summarize", budget: usdc("0.10") },
      { jobId: 5n, category: undefined },
    ];
    const events: DutyEvent[] = [];
    const recovered = new Promise<void>((resolve) => {
      events.push = (event: DutyEvent) => {
        Array.prototype.push.call(events, event);
        if (event.type === "recovered") resolve();
        return events.length;
      };
    });
    const hosted = await hostAgent(config, {
      walletClient,
      publicClient,
      deployment,
      anthropic: scriptedModel([]),
      resolver: resolverOf({}),
      compliance: {
        policy,
        prover: { prove: async () => { throw new Error("not asked"); } },
        state: { load: () => kept, save: () => undefined },
        discover: false,
        intervalMs: 60_000,
        onEvent: (event) => events.push(event),
      },
    });
    await recovered;
    expect(events[0]).toEqual({ type: "recovered", restored: [4n, 5n], discovered: [] });
    expect(hosted.duty!.jobs()).toEqual(kept);
    // The budget the state kept is escrow the allowance counts again; a job with none is read back from the chain on the next view.
    expect(hosted.allowance!.inFlightJobs()).toEqual([{ jobId: 4n, budget: usdc("0.10") }]);
    await hosted.close();
  });

  it("takes the platform's client for the platform tier, and wants an endpoint to resolve the agents it delegates to", async () => {
    const platform = scriptedModel([]);
    const hosted = await hostAgent({ ...config, delegation: undefined, capabilities: [config.capabilities[2]!] }, { walletClient, publicClient, deployment, anthropic: platform });
    expect(hosted.model).toBe(platform);
    expect(hosted.allowance).toBeUndefined();
    await expect(hostAgent(config, { walletClient, publicClient, deployment, anthropic: platform })).rejects.toThrow(/pass rpcUrl or a resolver/);
  });
});
