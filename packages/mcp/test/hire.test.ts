import { describe, expect, it } from "vitest";
import { A2AClient, WellKnownCache } from "@squaresdk/a2a";
import { hashDeliverable } from "@squaresdk/core";
import { parseUnits } from "viem";
import { lookupAgent } from "../src/agents.js";
import { hire, HireRefusedError } from "../src/hire.js";
import { fakeAgent, fakeChain, fetchRouting } from "./helpers/fakeChain.js";
import { CHAIN_ID, WALLET, card, deployment, didOf, resolution, resolverOf } from "./helpers/fakes.js";

/**
 * `hire` on its own: the seam a host with an allowance composes on. The
 * MCP tool over it is test/server.test.ts.
 */
const ATLAS = didOf(7);
const ORIGIN = "https://atlas.example";

function stage() {
  const chain = fakeChain();
  const agent = fakeAgent({
    card: card({ agentId: 7n }),
    provider: WALLET,
    agentId: 7n,
    chain,
    handlers: { "text.summarize": async ({ input }) => `${input.split(" ").length} words` },
  });
  const fetch = fetchRouting({ [ORIGIN]: agent.app });
  const resolver = resolverOf({ [ATLAS]: resolution(ATLAS, { wallet: WALLET, services: [{ name: "A2A", endpoint: `${ORIGIN}/a2a` }] }) });
  const cards = new WellKnownCache({ fetch });
  const a2a = new A2AClient({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const profile = () => lookupAgent(ATLAS, { resolver, cards, chainId: CHAIN_ID, usdc: deployment.usdc });
  return { chain, a2a, profile };
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
