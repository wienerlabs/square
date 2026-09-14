import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { daysToBitmask, deriveSalts, fieldToHex, policyCommitment, POLICY_FIELDS } from "../src/commitment.js";
import { MIN_POLICY_SALT, parsePolicy, type Policy } from "../src/policy.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROVER = join(REPO, "services", "prover", "src", "prover.js");
const HELPERS = join(REPO, "circuits", "test", "helpers", "inputs.mjs");
const proverInstalled = existsSync(join(REPO, "services", "prover", "node_modules", "circomlibjs")) && existsSync(join(REPO, "circuits", "node_modules", "circomlibjs"));

const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const BLOCKED = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;

const policy = (overrides: Partial<Policy> = {}): Policy =>
  parsePolicy({
    policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
    policy_salt: (MIN_POLICY_SALT + 98765n).toString(),
    operator_id: OPERATOR,
    max_daily_spend: "100000",
    max_per_transaction: "50000",
    allowed_endpoint_categories: ["api-call", "text.summarize"],
    blocked_addresses: [BLOCKED],
    token_whitelist: [USDC],
    ...overrides,
  });

describe("policyCommitment", () => {
  it("is a field element, the same on every call, and moves with the salt", async () => {
    const a = await policyCommitment(policy());
    const b = await policyCommitment(policy());
    const c = await policyCommitment(policy({ policy_salt: (MIN_POLICY_SALT + 98766n).toString() }));
    expect(a.root).toBe(b.root);
    expect(a.root).not.toBe(c.root);
    expect(a.hex).toBe(fieldToHex(a.root));
    expect(a.hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.leaves).toHaveLength(POLICY_FIELDS.length);
  });

  it("commits to every field: a change to any one of the eight moves the root", async () => {
    const roots = await Promise.all(
      [
        policy(),
        policy({ max_daily_spend: "100001" }),
        policy({ max_per_transaction: "50001" }),
        policy({ operator_id: BLOCKED }),
        policy({ policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5c" }),
        policy({ allowed_endpoint_categories: ["api-call"] }),
        policy({ blocked_addresses: [] }),
        policy({ token_whitelist: [USDC, BLOCKED] }),
        policy({ time_restrictions: [{ allowed_days: ["monday"], allowed_hours_start: 9, allowed_hours_end: 17 }] }),
      ].map((p) => policyCommitment(p).then((c) => c.root)),
    );
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("derives eight distinct salts from the one secret", async () => {
    const salts = await deriveSalts(MIN_POLICY_SALT + 1n);
    expect(salts).toHaveLength(8);
    expect(new Set(salts.map(String)).size).toBe(8);
  });

  it("packs weekdays with monday as bit 0", () => {
    expect(daysToBitmask(["monday"])).toBe(1n);
    expect(daysToBitmask(["sunday", "Tuesday"])).toBe(64n + 2n);
    expect(() => daysToBitmask(["funday"])).toThrow(/not a weekday/);
  });
});

describe.skipIf(!proverInstalled)("against the prover's own construction", () => {
  // The prover (services/prover/src/prover.js) builds the circuit input and
  // circuits/test/helpers/inputs.mjs hashes it the way the circuit does; the
  // two are held together by the circuit's tests. This holds this package to
  // them, on the same policies, so a policy committed from here is the one
  // the prover proves.
  it.each([
    ["no window", policy()],
    ["a window", policy({ time_restrictions: [{ allowed_days: ["monday", "wednesday", "sunday"], allowed_hours_start: 8, allowed_hours_end: 18 }] })],
    ["full lists", policy({ allowed_endpoint_categories: Array.from({ length: 8 }, (_, i) => `cat-${i}`), blocked_addresses: Array.from({ length: 10 }, () => BLOCKED), token_whitelist: Array.from({ length: 10 }, () => USDC) })],
    ["empty blocked list", policy({ blocked_addresses: [] })],
  ])("agrees with the prover on a policy with %s", async (_label, p) => {
    const { buildCircuitInput } = (await import(pathToFileURL(PROVER).href)) as { buildCircuitInput: (request: unknown) => Promise<unknown> };
    const { policyDataHash } = (await import(pathToFileURL(HELPERS).href)) as { policyDataHash: (input: unknown) => Promise<string> };
    const input = await buildCircuitInput({
      ...p,
      payment_amount: "1",
      payment_token: USDC,
      payment_recipient: OPERATOR,
      payment_endpoint_category: p.allowed_endpoint_categories[0],
      daily_spent_before: "0",
      current_unix_timestamp: "1800000000",
    });
    expect((await policyCommitment(p)).root.toString()).toBe(await policyDataHash(input));
  }, 30_000);
});
