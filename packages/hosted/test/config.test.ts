import { describe, expect, it } from "vitest";
import { HostedConfigError, parseHostedConfig } from "../src/config.js";
import { SEALED_PREFIX } from "../src/sealed.js";

const base = {
  name: "Acme Research",
  description: "Briefs, with sources.",
  agentId: "7",
  url: "https://research.acme.example",
  provider: { tier: "platform" },
  capabilities: [{ id: "research.brief", description: "A brief.", price: "0.50", instructions: "Write a brief." }],
};

describe("parseHostedConfig", () => {
  it("accepts a configuration and keeps what it was given", () => {
    const config = parseHostedConfig({
      ...base,
      tools: [{ name: "weather", url: "https://weather.example/mcp", headers: { authorization: "Bearer x" } }],
      delegation: { allow: ["did:aip:eip155:31337:0x0000000000000000000000000000000000000001:2"], maxPerJob: "0.25" },
      capabilities: [{ ...base.capabilities[0], delegate: true, tools: false }],
      maxTurns: 6,
    });
    expect(config.capabilities[0]).toMatchObject({ id: "research.brief", delegate: true, tools: false });
    expect(config.delegation?.maxPerJob).toBe("0.25");
    expect(config.tools?.[0]?.headers).toEqual({ authorization: "Bearer x" });
  });

  it("takes a compliance block beside a delegation block, and refuses one without", () => {
    const delegation = { allow: ["https://scribe.example"] };
    const compliance = { policyFile: "policy.json", intervalMs: 5000 };
    expect(parseHostedConfig({ ...base, delegation, compliance }).compliance).toEqual(compliance);
    expect(() => parseHostedConfig({ ...base, compliance })).toThrow(/compliance: names a policy, but the config delegates nothing/);
    expect(() => parseHostedConfig({ ...base, delegation, compliance: { ...compliance, intervalMs: 10 } })).toThrow(/compliance.intervalMs/);
    // Where the duty keeps its jobs across restarts: a path beside the config, or none at all (square#348).
    expect(parseHostedConfig({ ...base, delegation, compliance: { ...compliance, stateFile: "jobs.json" } }).compliance?.stateFile).toBe("jobs.json");
    expect(parseHostedConfig({ ...base, delegation, compliance: { ...compliance, stateFile: false } }).compliance?.stateFile).toBe(false);
    expect(() => parseHostedConfig({ ...base, delegation, compliance: { ...compliance, stateFile: "" } })).toThrow(/compliance.stateFile/);
  });

  it("names what is wrong, by path", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...base, agentId: "seven" }, /agentId: a decimal ERC-8004 id/],
      [{ ...base, capabilities: [] }, /capabilities: an agent with no capability has no card/],
      [{ ...base, capabilities: [{ ...base.capabilities[0], id: "Research_Brief" }] }, /capabilities.0.id: dotted lowercase/],
      [{ ...base, capabilities: [{ ...base.capabilities[0], price: "0.5000000" }] }, /price: decimal USDC/],
      [{ ...base, provider: { tier: "own", apiKey: "sk-ant-plain" } }, new RegExp(`provider.apiKey: an own key is stored sealed \\(${SEALED_PREFIX}`)],
      [{ ...base, provider: { tier: "other" } }, /provider/],
      [{ ...base, tools: [{ name: "a__b", url: "https://x.example/mcp" }] }, /tools.0.name/],
      [{ ...base, delegation: { allow: [] } }, /delegation.allow: list the agents/],
      [{ ...base, capabilities: [base.capabilities[0], base.capabilities[0]] }, /research.brief is declared twice/],
      [{ ...base, capabilities: [{ ...base.capabilities[0], delegate: true }] }, /delegates, but the config has no delegation block/],
    ];
    for (const [json, message] of cases) {
      expect(() => parseHostedConfig(json), JSON.stringify(json)).toThrow(HostedConfigError);
      expect(() => parseHostedConfig(json), JSON.stringify(json)).toThrow(message);
    }
  });

  it("takes a sealed own key", () => {
    const config = parseHostedConfig({ ...base, provider: { tier: "own", apiKey: `${SEALED_PREFIX}AAAA`, model: "claude-opus-5" } });
    expect(config.provider).toEqual({ tier: "own", apiKey: `${SEALED_PREFIX}AAAA`, model: "claude-opus-5" });
  });
});
