import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { a2aEndpointOf, registrationFile, AIP_EXTENSION_TYPE, REGISTRATION_TYPE } from "../src/card.js";

/**
 * The card the agent serves is held to docs/agent-card/schema.json, the
 * schema square#8 fixed, by the same validator the CLI uses.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, "../../../docs/agent-card/schema.json"), "utf8")) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const REGISTRY = "eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e";
const base = {
  name: "Atlas",
  description: "A research agent.",
  url: "https://atlas.example",
  did: "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:7",
  agentId: 7n,
  agentRegistry: REGISTRY,
  token: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
};

describe("the registration file", () => {
  it("validates against the schema, priced and unpriced capabilities alike", () => {
    const card = registrationFile({
      ...base,
      capabilities: [
        { id: "text.summarize", description: "Summarise a document.", price: "0.05" },
        { id: "text.echo", description: "Echo." },
      ],
      slug: "atlas",
      agentVersion: "1.0.0",
      x402Support: true,
    });
    const ok = validate(card);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(card.type).toBe(REGISTRATION_TYPE);
    expect(card["x-aip"].type).toBe(AIP_EXTENSION_TYPE);
    expect(card["x-aip"].capabilities).toEqual([
      { id: "text.summarize", description: "Summarise a document.", pricing: { amount: "0.05", token: base.token, network: "eip155:5042002" } },
      { id: "text.echo", description: "Echo." },
    ]);
    expect(card.registrations).toEqual([{ agentId: 7, agentRegistry: REGISTRY }]);
    expect(card.services).toContainEqual({ name: "A2A", endpoint: "https://atlas.example/a2a", version: "0.3.0" });
    expect(card.services).toContainEqual({ name: "DID", endpoint: base.did, version: "v2" });
  });

  it("points the A2A service at /a2a on the agent's origin, whatever path the url carried", () => {
    expect(a2aEndpointOf("https://atlas.example/some/page?x=1")).toBe("https://atlas.example/a2a");
  });

  it("refuses a card with no capability, and a capability id the schema would refuse", () => {
    expect(() => registrationFile({ ...base, capabilities: [] })).toThrow(/no capability/);
    expect(() => registrationFile({ ...base, capabilities: [{ id: "Text.Summarize", description: "x" }] })).toThrow(/dotted lowercase/);
  });

  it("carries an agent id past 2^53 as a string, which the schema allows", () => {
    const card = registrationFile({ ...base, agentId: 2n ** 60n, capabilities: [{ id: "a", description: "b" }] });
    expect(card.registrations[0]?.agentId).toBe((2n ** 60n).toString());
    expect(validate(card)).toBe(true);
  });
});
