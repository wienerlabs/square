import { describe, expect, it } from "vitest";
import { A2AClient, WellKnownCache } from "@squaresdk/a2a";
import { hashDeliverable, JobStatus, type ScreeningState } from "@squaresdk/core";
import { parseUnits } from "viem";
import { lookupAgent } from "../src/agents.js";
import { hire, HireRefusedError } from "../src/hire.js";
import { fakeAgent, fakeChain, fetchRouting } from "./helpers/fakeChain.js";
import { CHAIN_ID, OWNER, WALLET, card, deployment, didOf, resolution, resolverOf } from "./helpers/fakes.js";

/**
 * `hire` on its own: the seam a host with an allowance composes on. The
 * MCP tool over it is test/server.test.ts.
 */
const ATLAS = didOf(7);
const ORIGIN = "https://atlas.example";

function stage(options: { module?: `0x${string}`; policy?: boolean; a2aFailures?: number; screening?: Partial<Record<string, ScreeningState>> } = {}) {
  const chain = fakeChain({ module: options.module, policy: options.policy, screening: options.screening });
  const agent = fakeAgent({
    card: card({ agentId: 7n }),
    provider: WALLET,
    agentId: 7n,
    chain,
    handlers: { "text.summarize": async ({ input }) => `${input.split(" ").length} words` },
  });
  const routed = fetchRouting({ [ORIGIN]: agent.app });
  // The first `a2aFailures` requests to the agent's endpoint are refused at the socket, as an endpoint that is down refuses them.
  const failures = { left: options.a2aFailures ?? 0, seen: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${ORIGIN}/a2a`) {
      failures.seen += 1;
      if (failures.left > 0) {
        failures.left -= 1;
        throw new Error("connect ECONNREFUSED");
      }
    }
    return routed(input, init);
  };
  const resolver = resolverOf({ [ATLAS]: resolution(ATLAS, { wallet: WALLET, services: [{ name: "A2A", endpoint: `${ORIGIN}/a2a` }] }) });
  const cards = new WellKnownCache({ fetch });
  const a2a = new A2AClient({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), maxRetries: 1 });
  const profile = () => lookupAgent(ATLAS, { resolver, cards, chainId: CHAIN_ID, usdc: deployment.usdc });
  return { chain, a2a, profile, failures };
}

describe("hire", () => {
  it("asks the host before spending and tells it after funding, with what the job holds", async () => {
    const { chain, a2a, profile } = stage();
    const asked: bigint[] = [];
    const funded: Array<{ jobId: bigint; budget: bigint; provider: string }> = [];
    const result = await hire({
      client: chain.client,
      a2a,
      profile: await profile(),
      capability: "text.summarize",
      input: "a b c",
      callerDid: "did:x",
      pollIntervalMs: 5,
      admit: async (amount) => {
        asked.push(amount);
        return undefined;
      },
      onFunded: (job) => {
        funded.push(job);
      },
    });
    expect(asked).toEqual([parseUnits("0.05", 6)]);
    expect(funded).toEqual([{ jobId: 1n, budget: parseUnits("0.05", 6), provider: WALLET }]);
    expect(result).toMatchObject({ jobId: 1n, taskId: "square-job-1", budget: parseUnits("0.05", 6), provider: WALLET, dispatch: "delivered" });
    expect(result.task?.deliverable).toBe(hashDeliverable("3 words"));
    expect(chain.writes).toHaveLength(4);
  });

  it("is refused by the host before the first transaction, and says nothing was funded", async () => {
    const { chain, a2a, profile } = stage();
    const attempt = hire({
      client: chain.client,
      a2a,
      profile: await profile(),
      capability: "text.summarize",
      input: "a b c",
      callerDid: "did:x",
      admit: async () => "the allowance says no",
    });
    await expect(attempt).rejects.toThrow(HireRefusedError);
    await expect(attempt).rejects.toMatchObject({ message: "the allowance says no", stage: "before-funding", transactions: {} });
    expect(chain.writes).toEqual([]);
  });

  it("refuses, before any money moves, a wallet with no policy on a stack whose hook holds a module (square#350)", async () => {
    const gated = stage({ module: "0x000000000000000000000000000000000000c0de" });
    const attempt = hire({ client: gated.chain.client, a2a: gated.a2a, profile: await gated.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x" });
    await expect(attempt).rejects.toMatchObject({ stage: "before-funding", message: expect.stringContaining("no policy on the registry and the stack gates releases") });
    expect(gated.chain.writes).toEqual([]);
    // With a policy committed, the same stack hires.
    const committed = stage({ module: "0x000000000000000000000000000000000000c0de", policy: true });
    const result = await hire({ client: committed.chain.client, a2a: committed.a2a, profile: await committed.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x", pollIntervalMs: 5 });
    expect(result.dispatch).toBe("delivered");
    // And a stack with no module asks nothing of the registry.
    const open = stage();
    const plain = await hire({ client: open.chain.client, a2a: open.a2a, profile: await open.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x", pollIntervalMs: 5 });
    expect(plain.dispatch).toBe("delivered");
  });

  it("names the party the screening refused, and leaves the job Open with its budget for a later hire (square#368)", async () => {
    const unscreened = stage({ screening: { [OWNER]: "cleared" } });
    const attempt = hire({ client: unscreened.chain.client, a2a: unscreened.a2a, profile: await unscreened.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x" });
    await expect(attempt).rejects.toMatchObject({
      stage: "funding",
      message: `job 1 was not funded: the provider ${WALLET} is unscreened, the registry holds no fresh, clean record for it and no screener is configured to ask; the job stays Open with its budget set and this wallet keeps its USDC. Once the provider is screened, hire again with jobId 1 to fund it.`,
      transactions: { createJob: expect.any(String), setBudget: expect.any(String) },
    });
    expect(unscreened.chain.writes.map((w) => w.split("(")[0])).toEqual(["createJob", "setBudget"]);
    expect(unscreened.chain.records.get(1n)?.status).toBe(JobStatus.Open);

    const designated = stage({ screening: { [OWNER]: "cleared", [WALLET]: "sanctioned" } });
    await expect(hire({ client: designated.chain.client, a2a: designated.a2a, profile: await designated.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x" })).rejects.toMatchObject({
      stage: "funding",
      message: expect.stringContaining(`the provider ${WALLET} is sanctioned, a fresh screening record says it is designated; the job stays Open with its budget set and this wallet keeps its USDC. Hire another agent.`),
    });

    // Both cleared: the same stack hires.
    const cleared = stage({ screening: { [OWNER]: "cleared", [WALLET]: "cleared" } });
    const result = await hire({ client: cleared.chain.client, a2a: cleared.a2a, profile: await cleared.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x", pollIntervalMs: 5 });
    expect(result.dispatch).toBe("delivered");
  });

  it("asks an endpoint that was down once more before coming back undispatched, and not an agent that refused (square#351)", async () => {
    const down = stage({ a2aFailures: 1 });
    const result = await hire({ client: down.chain.client, a2a: down.a2a, profile: await down.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x", pollIntervalMs: 5, redispatchDelayMs: 0 });
    expect(result.dispatch).toBe("delivered");
    expect(down.failures.seen).toBeGreaterThanOrEqual(2);

    const stillDown = stage({ a2aFailures: 10 });
    const twice = await hire({ client: stillDown.chain.client, a2a: stillDown.a2a, profile: await stillDown.profile(), capability: "text.summarize", input: "a b c", callerDid: "did:x", pollIntervalMs: 5, redispatchDelayMs: 0 });
    expect(twice).toMatchObject({ dispatch: "undispatched", reason: expect.stringContaining("(asked twice)") });
    expect(stillDown.chain.records.get(1n)?.status).toBe(JobStatus.Funded); // the escrow stayed on the job
  });

  it("carries on with an Open job this wallet already created instead of opening another (square#351)", async () => {
    const { chain, a2a, profile } = stage();
    const p = await profile();
    // A hire whose fund failed: the job is Open with its budget set.
    const client = chain.client;
    const noFunds = {
      ...client,
      fund: async () => {
        throw new Error("ERC20InsufficientBalance");
      },
    } as unknown as typeof client;
    Object.defineProperty(noFunds, "account", { get: () => client.account });
    await expect(hire({ client: noFunds, a2a, profile: p, capability: "text.summarize", input: "x", callerDid: "did:x" })).rejects.toMatchObject({ stage: "funding" });
    expect(chain.records.get(1n)).toMatchObject({ status: JobStatus.Open, budget: parseUnits("0.05", 6) });

    const funded: bigint[] = [];
    const result = await hire({ client, a2a, profile: p, capability: "text.summarize", input: "x", callerDid: "did:x", pollIntervalMs: 5, jobId: 1n, onFunded: (job) => { funded.push(job.jobId); } });
    expect(result).toMatchObject({ jobId: 1n, dispatch: "delivered" });
    expect(funded).toEqual([1n]);
    expect(chain.records.size).toBe(1);
    // The budget was already set, so only fund and the agent's submit were written after the first attempt's two.
    expect(chain.writes.slice(2)).toEqual([`fund(1, ${parseUnits("0.05", 6)})`, expect.stringMatching(/^submit\(1, /)]);

    // Not somebody else's, not a funded one, not for another agent.
    chain.records.set(9n, { ...chain.records.get(1n)!, status: JobStatus.Open, client: "0x0000000000000000000000000000000000000009" });
    await expect(hire({ client, a2a, profile: p, capability: "text.summarize", input: "x", callerDid: "did:x", jobId: 9n })).rejects.toMatchObject({ stage: "before-funding", message: expect.stringContaining("not this wallet") });
    await expect(hire({ client, a2a, profile: p, capability: "text.summarize", input: "x", callerDid: "did:x", jobId: 1n })).rejects.toMatchObject({ message: expect.stringContaining("is Submitted, not Open") });
  });

  it("reports a funding that failed part way with what landed", async () => {
    const { chain, a2a, profile } = stage();
    const p = await profile();
    // Budget the job under the provider's hand: fund then mismatches.
    const client = chain.client;
    const brokenClient = { ...client, setBudget: async (id: bigint, amount: bigint) => client.setBudget(id, amount + 1n) } as typeof client;
    Object.defineProperty(brokenClient, "account", { get: () => client.account });
    const attempt = hire({ client: brokenClient, a2a, profile: p, capability: "text.summarize", input: "x", callerDid: "did:x" });
    await expect(attempt).rejects.toMatchObject({ stage: "funding", message: "the job could not be funded: BudgetMismatch()" });
    await expect(attempt).rejects.toMatchObject({ transactions: { createJob: expect.any(String), setBudget: expect.any(String) } });
  });
});
