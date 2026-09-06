import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { summarizeCard } from "../src/core/agent-card.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "../../../docs/agent-card/examples");

function example(name: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES, name), "utf8"));
}

describe("summarizeCard", () => {
  it("accepts the specification's own examples", () => {
    // If the CLI cannot read the cards the docs publish, one of the two is wrong.
    for (const name of ["typical.json", "full.json"]) {
      const summary = summarizeCard(example(name), name);
      expect(summary.name).toBeTruthy();
      expect(summary.file).toBeTypeOf("object");
    }
  });

  it("counts services", () => {
    const summary = summarizeCard(
      { name: "a", type: "AgentCard", services: [{ name: "A2A" }, { name: "MCP" }] },
      "inline",
    );
    expect(summary.serviceCount).toBe(2);
  });

  it("warns about a card with no name", () => {
    expect(summarizeCard({ type: "AgentCard" }, "inline").warnings.join(" ")).toMatch(/name/);
  });

  it("warns when the card is already marked inactive", () => {
    expect(summarizeCard({ name: "a", type: "t", active: false }, "inline").warnings.join(" "))
      .toMatch(/deactivated/);
  });

  it("warns about a pre-filled agentId, which the mint has not assigned yet", () => {
    const warnings = summarizeCard(
      { name: "a", type: "t", registrations: [{ agentId: 7 }] },
      "inline",
    ).warnings.join(" ");
    expect(warnings).toMatch(/setAgentURI/);
  });

  it("does not warn about a complete card", () => {
    expect(
      summarizeCard({ name: "a", type: "AgentCard", registrations: [{}] }, "inline").warnings,
    ).toHaveLength(0);
  });

  it("rejects a JSON array", () => {
    expect(() => summarizeCard([], "inline")).toThrow(/not a JSON object/);
  });

  it("rejects a card whose registrations are not objects", () => {
    expect(() => summarizeCard({ registrations: ["nope"] }, "inline")).toThrow(/not a usable/);
  });

  it("preserves fields it does not know about", () => {
    const summary = summarizeCard({ name: "a", type: "t", "x-aip": { pricing: [] } }, "inline");
    expect(summary.file["x-aip"]).toEqual({ pricing: [] });
  });
});
