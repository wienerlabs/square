import { approveBuyers } from "@squaresdk/core";
import { parsePolicy, policyToJson } from "@squaresdk/policy";
import { describe, expect, it } from "vitest";
import { buyersFromText, EMPTY_FORM, entryFor, policyFromForm, policyFromPaste } from "./policy";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;

describe("policyFromForm", () => {
  it("reads a filled form into a policy the prover accepts, USDC by default, and draws the secret", () => {
    const result = policyFromForm({ ...EMPTY_FORM, daily: "100", perTx: "10", categories: "text.summarize, research.brief" }, OWNER, USDC);
    expect(result.kind).toBe("policy");
    if (result.kind !== "policy") return;
    expect(result.policy).toMatchObject({ operator_id: OWNER, max_daily_spend: "100000000", max_per_transaction: "10000000", allowed_endpoint_categories: ["text.summarize", "research.brief"], token_whitelist: [USDC], blocked_addresses: [] });
    expect(BigInt(result.policy.policy_salt)).toBeGreaterThanOrEqual(1n << 128n);
    expect(parsePolicy(JSON.parse(policyToJson(result.policy)))).toEqual(result.policy);
  });

  it("takes a window, tokens and blocked payees", () => {
    const result = policyFromForm({ daily: "1", perTx: "1", categories: "c", tokens: `${USDC}\n${OTHER}`, blocked: OTHER, windowOn: true, days: ["monday", "friday"], hoursStart: "9", hoursEnd: "17" }, OWNER, USDC);
    expect(result).toMatchObject({ kind: "policy", policy: { token_whitelist: [USDC, OTHER], blocked_addresses: [OTHER], time_restrictions: [{ allowed_days: ["monday", "friday"], allowed_hours_start: 9, allowed_hours_end: 17 }] } });
  });

  it.each([
    ["no ceilings", { daily: "", perTx: "", categories: "c" }, ["daily", "perTx"]],
    ["a release above the day", { daily: "1", perTx: "2", categories: "c" }, ["perTx"]],
    ["no capability", { daily: "1", perTx: "1", categories: "" }, ["categories"]],
    ["a bad token", { daily: "1", perTx: "1", categories: "c", tokens: "nope" }, ["tokens"]],
    ["a bad blocked address", { daily: "1", perTx: "1", categories: "c", blocked: "0x12" }, ["blocked"]],
    ["a window with no day", { daily: "1", perTx: "1", categories: "c", windowOn: true, days: [], hoursStart: "9", hoursEnd: "25" }, ["days", "hoursEnd"]],
  ])("names what is wrong with %s, by field", (_label, form, fields) => {
    const result = policyFromForm({ ...EMPTY_FORM, ...form } as typeof EMPTY_FORM, OWNER, USDC);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(Object.keys(result.errors).sort()).toEqual([...fields].sort());
  });
});

describe("policyFromPaste", () => {
  it("takes a file for the connected wallet and refuses another wallet's", () => {
    const mine = policyFromForm({ ...EMPTY_FORM, daily: "1", perTx: "1", categories: "c" }, OWNER, USDC);
    if (mine.kind !== "policy") throw new Error("form");
    expect(policyFromPaste(policyToJson(mine.policy), OWNER)).toMatchObject({ kind: "policy" });
    expect(policyFromPaste(policyToJson(mine.policy), OTHER)).toMatchObject({ kind: "invalid", message: /the connected wallet is/ });
    expect(policyFromPaste("{", OWNER)).toEqual({ kind: "invalid", message: "Not JSON." });
    expect(policyFromPaste("{}", OWNER)).toMatchObject({ kind: "invalid", message: /policy_id: missing/ });
  });
});

describe("buyers", () => {
  it("reads addresses from a textarea and issues the entry the purchase form takes", () => {
    expect(buyersFromText(`${OWNER}\n${OTHER.toLowerCase()},`)).toEqual({ kind: "buyers", buyers: [OWNER, OTHER] });
    expect(buyersFromText("")).toMatchObject({ kind: "invalid" });
    expect(buyersFromText(`${OWNER} ${OWNER}`)).toMatchObject({ kind: "invalid", message: /twice/ });
    const list = approveBuyers([OWNER, OTHER]);
    const entry = JSON.parse(entryFor(list, OTHER)) as { buyer: string; salt: string; proof: string[] };
    expect(entry).toEqual({ buyer: OTHER, ...list.eligibilityOf(OTHER) });
  });
});
