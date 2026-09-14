import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { deploymentFor, JobStatus, type SquareWalletClient } from "@squaresdk/core";
import { createPayingFetch, networkOf } from "@squaresdk/x402";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PublicClient } from "viem";
import { createAgent } from "../src/agent.js";

/**
 * The agent's HTTP surface, driven through the Hono app without a socket:
 * the card, the A2A endpoint's admission, and the paid route. The chain is a
 * stub answering `getJobRecord`; the real one is test/anvil.test.ts.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, "../../../docs/agent-card/schema.json"), "utf8")) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const deployment = deploymentFor(31337);
const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil 2, owner of mock agent 1
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil 1
const CALLER = "did:aip:eip155:31337:0x0000000000000000000000000000000000000001:9";

function chainStub(records: Record<string, { status: number; provider: `0x${string}`; budget: bigint; expiredAt: number; settlementHorizon: number }>) {
  const publicClient = {
    chain: { id: 31337 },
    getChainId: async () => 31337,
    // The chain's clock, which admission measures the job's window against.
    getBlock: async () => ({ timestamp: 1_800_000_000n }),
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName !== "getJobRecord") throw new Error(`unexpected read ${functionName}`);
      const record = records[String(args[0])];
      if (!record) throw new Error("InvalidJob()");
      return record;
    },
  } as unknown as PublicClient;
  const walletClient = { account: owner, chain: { id: 31337 } } as unknown as SquareWalletClient;
  return { publicClient, walletClient };
}

function acceptingFacilitator(): FacilitatorClient & { settled: string[] } {
  const settled: string[] = [];
  return {
    settled,
    verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
      return Promise.resolve({ isValid: true, payer: payer.address } as VerifyResponse);
    },
    settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      settled.push(requirements.amount);
      return Promise.resolve({ success: true, transaction: ("0x" + "ab".repeat(32)) as Hex, network: requirements.network, payer: payer.address } as unknown as SettleResponse);
    },
    getSupported(): Promise<SupportedResponse> {
      return Promise.resolve({ kinds: [{ x402Version: 2, scheme: "exact", network: networkOf(31337) }], signers: { "eip155:*": [owner.address] } } as unknown as SupportedResponse);
    },
  };
}

function atlas(x402?: FacilitatorClient) {
  const { publicClient, walletClient } = chainStub({
    "1": { status: JobStatus.Open, provider: owner.address, budget: 0n, expiredAt: 4_000_000_000, settlementHorizon: 86_400 },
    "2": { status: JobStatus.Funded, provider: owner.address, budget: 49_999n, expiredAt: 4_000_000_000, settlementHorizon: 86_400 },
  });
  return createAgent({
    name: "Atlas",
    description: "Summarises.",
    walletClient,
    publicClient,
    deployment,
    agentId: 1n,
    url: "https://atlas.example",
    ...(x402 ? { x402: { facilitator: x402 } } : {}),
  }).capability("text.summarize", {
    description: "Summarise a document.",
    price: "0.05",
    handler: async ({ input, jobId }) => `${input.split(" ").length} words${jobId ? ` for job ${jobId}` : ""}`,
  });
}

const rpc = (method: string, params: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

describe("what the agent serves", () => {
  it("the card at the well-known path, valid against the schema, naming the wallet's did and the capability's price", async () => {
    const agent = atlas();
    const res = await agent.app.request("https://atlas.example/.well-known/agent-registration.json");
    expect(res.status).toBe(200);
    const card = (await res.json()) as ReturnType<typeof agent.card>;
    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
    expect(card.services).toContainEqual({ name: "A2A", endpoint: "https://atlas.example/a2a", version: "0.3.0" });
    expect(card.services).toContainEqual({ name: "DID", endpoint: agent.did, version: "v2" });
    expect(agent.did).toBe(`did:aip:eip155:31337:${deployment.identityRegistry.toLowerCase()}:1`);
    expect(card["x-aip"].capabilities[0]?.pricing).toEqual({ amount: "0.05", token: deployment.usdc.toLowerCase(), network: "eip155:31337" });
    expect(card.x402Support).toBe(false);
    expect(agent.address).toBe(owner.address);
  });

  it("refuses a task whose job the chain shows Open, and one funded below the price, before the handler runs", async () => {
    const agent = atlas();
    const open = await agent.app.request("https://atlas.example/a2a", rpc("task/create", { taskId: "t1", capability: "text.summarize", input: "a b c", callerDid: CALLER, jobId: "1" }));
    expect((await open.json()) as unknown).toMatchObject({ error: { code: -32004, message: "job 1 is Open, not Funded" } });
    const cheap = await agent.app.request("https://atlas.example/a2a", rpc("task/create", { taskId: "t2", capability: "text.summarize", input: "a b c", callerDid: CALLER, jobId: "2" }));
    expect((await cheap.json()) as unknown).toMatchObject({ error: { code: -32004, message: "job 2 is funded with 49999 but text.summarize costs 50000" } });
  });

  it("answers a body that is not JSON in the envelope", async () => {
    const res = await atlas().app.request("https://atlas.example/a2a", { method: "POST", body: "{" });
    expect((await res.json()) as unknown).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
  });

  it("has no paid route without x402", async () => {
    const res = await atlas().app.request("https://atlas.example/pay/text.summarize", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("with x402, serves the priced capability per call, for its price, with no job", async () => {
    const facilitator = acceptingFacilitator();
    const agent = atlas(facilitator);
    expect(agent.card().x402Support).toBe(true);
    const unpaid = await agent.app.request("https://atlas.example/pay/text.summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "one two three" }) });
    expect(unpaid.status).toBe(402);
    const payingFetch = createPayingFetch({
      account: payer,
      network: networkOf(31337),
      asset: deployment.usdc,
      maxAmountPerPayment: "1.00",
      fetch: async (input, init) => agent.app.request(input as Parameters<typeof agent.app.request>[0], init),
    });
    const paid = await payingFetch("https://atlas.example/pay/text.summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "one two three" }) });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ capability: "text.summarize", output: "3 words" });
    expect(facilitator.settled).toEqual(["50000"]);
    expect(() => agent.capability("late.one", { description: "x", handler: async () => "" })).toThrow(/declared after the paid routes/);
  });
});
