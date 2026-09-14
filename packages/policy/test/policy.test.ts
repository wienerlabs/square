import { describe, expect, it } from "vitest";
import { BN254_R, MIN_POLICY_SALT, newPolicy, parsePolicy, PolicyError, policyToJson, randomPolicySalt, redactPolicy } from "../src/policy.js";

const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

const base = () => ({
  policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
  policy_salt: (MIN_POLICY_SALT + 12345n).toString(),
  operator_id: OPERATOR.toLowerCase(),
  max_daily_spend: "100000000",
  max_per_transaction: "50000000",
  allowed_endpoint_categories: ["text.summarize"],
  blocked_addresses: [],
  token_whitelist: [USDC.toLowerCase()],
});

describe("randomPolicySalt", () => {
  it("draws a field element at or above the prover's floor, fresh each time", () => {
    const a = BigInt(randomPolicySalt());
    const b = BigInt(randomPolicySalt());
    expect(a).toBeGreaterThanOrEqual(MIN_POLICY_SALT);
    expect(a).toBeLessThan(BN254_R);
    expect(a).not.toBe(b);
  });
});

describe("parsePolicy", () => {
  it("reads the prover's vocabulary and checksums the addresses", () => {
    const policy = parsePolicy(base());
    expect(policy.operator_id).toBe(OPERATOR);
    expect(policy.token_whitelist).toEqual([USDC]);
    expect(policy.time_restrictions).toBeUndefined();
    expect(JSON.parse(policyToJson(policy))).toEqual(policy);
  });

  it("reads one time window, with the weekdays lowercased", () => {
    const policy = parsePolicy({ ...base(), time_restrictions: [{ allowed_days: ["Monday", "friday"], allowed_hours_start: "9", allowed_hours_end: 17 }] });
    expect(policy.time_restrictions).toEqual([{ allowed_days: ["monday", "friday"], allowed_hours_start: 9, allowed_hours_end: 17 }]);
  });

  it.each([
    ["a missing field", { ...base(), token_whitelist: undefined }, /token_whitelist: missing/],
    ["a salt under the floor", { ...base(), policy_salt: "7777777" }, /policy_salt: must be at least 2\^128/],
    ["a salt outside the field", { ...base(), policy_salt: BN254_R.toString() }, /policy_salt: does not fit/],
    ["a ceiling over 64 bits", { ...base(), max_daily_spend: (1n << 64n).toString() }, /max_daily_spend: does not fit in 64 bits/],
    ["a negative amount", { ...base(), max_per_transaction: "-1" }, /max_per_transaction: must be a non-negative integer/],
    ["a bad uuid", { ...base(), policy_id: "not-a-uuid" }, /policy_id: not a valid UUID/],
    ["a bad address", { ...base(), operator_id: "0x1234" }, /operator_id: must be a 20-byte hex address/],
    ["a bad list entry", { ...base(), blocked_addresses: ["nope"] }, /blocked_addresses\[0\]: must be a 20-byte hex address/],
    ["a category over 32 bytes", { ...base(), allowed_endpoint_categories: ["x".repeat(33)] }, /allowed_endpoint_categories\[0\]: exceeds 32 bytes/],
    ["nine categories", { ...base(), allowed_endpoint_categories: Array.from({ length: 9 }, (_, i) => `c${i}`) }, /at most 8 entries/],
    ["eleven tokens", { ...base(), token_whitelist: Array.from({ length: 11 }, () => USDC) }, /at most 10 entries/],
    ["two time windows", { ...base(), time_restrictions: [{ allowed_days: ["monday"], allowed_hours_start: 1, allowed_hours_end: 2 }, { allowed_days: ["monday"], allowed_hours_start: 1, allowed_hours_end: 2 }] }, /exactly one window/],
    ["an empty window", { ...base(), time_restrictions: [] }, /exactly one window/],
    ["a window with no day", { ...base(), time_restrictions: [{ allowed_days: [], allowed_hours_start: 1, allowed_hours_end: 2 }] }, /at least one weekday/],
    ["an hour of 24", { ...base(), time_restrictions: [{ allowed_days: ["monday"], allowed_hours_start: 1, allowed_hours_end: 24 }] }, /must be an hour of the day/],
  ])("refuses %s the way the prover would", (_label, json, message) => {
    expect(() => parsePolicy(json)).toThrow(PolicyError);
    expect(() => parsePolicy(json)).toThrow(message);
  });
});

describe("newPolicy", () => {
  it("draws an id and a salt, and validates the rest", () => {
    const policy = newPolicy({ operator: OPERATOR, maxDailySpend: 100_000_000n, maxPerTransaction: 50_000_000n, categories: ["text.summarize"], tokens: [USDC] });
    expect(policy.policy_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(BigInt(policy.policy_salt)).toBeGreaterThanOrEqual(MIN_POLICY_SALT);
    expect(policy.blocked_addresses).toEqual([]);
    expect(redactPolicy(policy).policy_salt).toBe("<redacted>");
    expect(() => newPolicy({ operator: OPERATOR, maxDailySpend: 1n, maxPerTransaction: 1n, categories: [], tokens: [], salt: "1" })).toThrow(/policy_salt/);
  });
});
