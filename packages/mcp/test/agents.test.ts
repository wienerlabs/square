import { describe, expect, it } from "vitest";
import { AgentLookupError, lookupAgent } from "../src/agents.js";
import { CHAIN_ID, OWNER, REGISTRY, WALLET, card, cardsOf, deployment, didOf, resolution, resolverOf } from "./helpers/fakes.js";

const WELL_KNOWN = "https://atlas.example/.well-known/agent-registration.json";
const A2A = [{ name: "A2A", endpoint: "https://atlas.example/a2a" }];
const options = (resolver: ReturnType<typeof resolverOf>, cards: ReturnType<typeof cardsOf>) => ({ resolver, cards, chainId: CHAIN_ID, usdc: deployment.usdc });

describe("lookupAgent by DID", () => {
  it("takes identity from the chain and the offer from the card, and prefers the agent wallet as the provider", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did, { wallet: WALLET, services: A2A }) });
    const cards = cardsOf({ [WELL_KNOWN]: card({ x402Support: true }) });
    const profile = await lookupAgent(did, options(resolver, cards));
    expect(profile).toEqual({
      did,
      agentId: "7",
      chainId: CHAIN_ID,
      registry: REGISTRY,
      owner: OWNER,
      provider: WALLET,
      deactivated: false,
      name: "Atlas",
      description: "Summarises what it is given.",
      a2aEndpoint: "https://atlas.example/a2a",
      x402Support: true,
      capabilities: [{ id: "text.summarize", description: "Summarise a document.", price: "0.05" }],
      warnings: [],
    });
    expect(cards.fetched).toEqual([WELL_KNOWN]);
  });

  it("is the owner's job when no agent wallet is set, and a price in another token is no price", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did, { services: A2A }) });
    const cards = cardsOf({ [WELL_KNOWN]: card({ token: "0x0000000000000000000000000000000000000001" }) });
    const profile = await lookupAgent(did, options(resolver, cards));
    expect(profile.provider).toBe(OWNER);
    expect(profile.capabilities).toEqual([{ id: "text.summarize", description: "Summarise a document." }]);
    expect(profile.warnings).toEqual([expect.stringMatching(/text\.summarize is priced in 0x0000000000000000000000000000000000000001 on eip155:31337, not this chain's USDC/)]);
  });

  it("says when the card does not register the DID it was reached through, and when there is no card", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did, { services: A2A }) });
    const other = await lookupAgent(did, options(resolver, cardsOf({ [WELL_KNOWN]: card({ agentId: 8n }) })));
    expect(other.warnings).toEqual([`the card at ${WELL_KNOWN} does not register ${did}`]);
    expect(other.capabilities).toHaveLength(1);
    const none = await lookupAgent(did, options(resolver, cardsOf({})));
    expect(none.warnings).toEqual([`no agent card at ${WELL_KNOWN}; the agent cannot be hired without one`]);
    expect(none.capabilities).toEqual([]);
    expect(none.a2aEndpoint).toBe("https://atlas.example/a2a");
  });

  it("carries the chain's deactivation, its warnings and an unreadable registration file", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did, { deactivated: true, warnings: ["tokenURI reverted"] }) });
    const profile = await lookupAgent(did, options(resolver, cardsOf({})));
    expect(profile.deactivated).toBe(true);
    expect(profile.a2aEndpoint).toBeUndefined();
    expect(profile.warnings).toEqual([
      "tokenURI reverted",
      "the on-chain registration file could not be read; the document lists no services",
      "agent card advertises no A2A service",
    ]);
  });

  it("refuses what it cannot look up", async () => {
    const resolver = resolverOf({ [didOf(7)]: resolution(didOf(7), { error: "networkError" }) });
    const opts = options(resolver, cardsOf({}));
    await expect(lookupAgent("atlas", opts)).rejects.toThrow(AgentLookupError);
    await expect(lookupAgent("atlas", opts)).rejects.toThrow(/neither a did:aip nor an https URL/);
    await expect(lookupAgent("did:aip:abc:xyz", opts)).rejects.toThrow(/v1 identifier|not a did:aip/);
    await expect(lookupAgent(didOf(7, 5042002), opts)).rejects.toThrow(/is on chain 5042002; this server works on chain 31337/);
    await expect(lookupAgent(didOf(7), opts)).rejects.toThrow(/did not resolve: networkError/);
    await expect(lookupAgent(didOf(9), opts)).rejects.toThrow(/did not resolve: notFound/);
  });
});

describe("lookupAgent by URL", () => {
  it("reads the DID off the card at the URL and resolves it, using the card's endpoint when the chain names none", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did) });
    const cards = cardsOf({ [WELL_KNOWN]: card() });
    const profile = await lookupAgent("https://atlas.example/anything", options(resolver, cards));
    expect(resolver.asked).toEqual([did]);
    expect(profile.did).toBe(did);
    expect(profile.a2aEndpoint).toBe("https://atlas.example/a2a");
    expect(profile.capabilities).toHaveLength(1);
    expect(profile.warnings).toEqual([
      "the on-chain registration file could not be read; the document lists no services",
      "agent card advertises no A2A service",
      `the chain names no A2A endpoint for ${did}; using the one the card at ${WELL_KNOWN} advertises`,
    ]);
  });

  it("lets the chain's endpoint win over the card's when both exist", async () => {
    const did = didOf(7);
    const resolver = resolverOf({ [did]: resolution(did, { services: [{ name: "A2A", endpoint: "https://real.atlas.example/a2a" }] }) });
    const cards = cardsOf({ [WELL_KNOWN]: card(), "https://real.atlas.example/.well-known/agent-registration.json": card({ url: "https://real.atlas.example" }) });
    const profile = await lookupAgent("https://atlas.example", options(resolver, cards));
    expect(profile.a2aEndpoint).toBe("https://real.atlas.example/a2a");
    expect(profile.warnings).toEqual([]);
  });

  it("refuses a URL with no card, or whose card registers no agent on this chain", async () => {
    const resolver = resolverOf({});
    await expect(lookupAgent("https://nowhere.example", options(resolver, cardsOf({})))).rejects.toThrow(/no agent card at https:\/\/nowhere.example\/.well-known/);
    const elsewhere = cardsOf({ [WELL_KNOWN]: card({ chainId: 5042002 }) });
    await expect(lookupAgent("https://atlas.example", options(resolver, elsewhere))).rejects.toThrow(
      `registers no agent on chain 31337 (it names ${didOf(7, 5042002)})`,
    );
    await expect(lookupAgent("https://10.0.0.1/", options(resolver, cardsOf({})))).rejects.toThrow(/private, link-local/);
  });
});
