import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveBuyers } from "@squaresdk/core";
import { parsePolicy, policyCommitment } from "@squaresdk/policy";
import { buildProgram } from "../src/cli.js";
import { ValidationError } from "../src/core/errors.js";

/**
 * `square policy` without a chain: what `init` writes and prints, what the
 * commands refuse before any network call, and a buyer's entry from the
 * kept list. The chain is test/policy.anvil.test.ts.
 */
const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEPLOYMENT = join(__dirname, "..", "..", "..", "contracts", "deployments", "5042002.json");

async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    await buildProgram().parseAsync(["node", "square", ...args]);
  } finally {
    spy.mockRestore();
  }
  return out.join("");
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "square-policy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("square policy init", () => {
  it("writes a policy the prover would accept, owner-only, with a fresh salt and the commitment it makes", async () => {
    const file = join(dir, "policy.json");
    const printed = JSON.parse(await run("policy", "init", "--out", file, "--operator", OPERATOR, "--daily", "100", "--per-tx", "10", "--category", "text.summarize", "--category", "research.brief", "--token", USDC, "--deployment", DEPLOYMENT, "--json")) as Record<string, string>;
    const written = parsePolicy(JSON.parse(await readFile(file, "utf8")));
    expect(written.operator_id).toBe(OPERATOR);
    expect(written.max_daily_spend).toBe("100000000");
    expect(written.max_per_transaction).toBe("10000000");
    expect(written.allowed_endpoint_categories).toEqual(["text.summarize", "research.brief"]);
    expect(written.token_whitelist).toEqual([USDC]);
    expect(BigInt(written.policy_salt)).toBeGreaterThanOrEqual(1n << 128n);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(printed).toMatchObject({ file, operator: OPERATOR, policyId: written.policy_id, dailyLimit: "100000000" });
    expect(printed["commitment"]).toBe((await policyCommitment(written)).hex);
  });

  it("takes the chain's USDC when no token is named, and a time window", async () => {
    const file = join(dir, "policy.json");
    await run("policy", "init", "--out", file, "--operator", OPERATOR, "--daily", "1", "--per-tx", "1", "--category", "c", "--days", "monday,friday", "--hours", "9-17", "--deployment", DEPLOYMENT, "--json");
    const written = parsePolicy(JSON.parse(await readFile(file, "utf8")));
    expect(written.token_whitelist).toEqual(["0x3600000000000000000000000000000000000000"]);
    expect(written.time_restrictions).toEqual([{ allowed_days: ["monday", "friday"], allowed_hours_start: 9, allowed_hours_end: 17 }]);
  });

  it.each([
    ["no category", ["--daily", "1", "--per-tx", "1"], /At least one --category/],
    ["a bad amount", ["--daily", "1.2345678", "--per-tx", "1", "--category", "c"], /--daily has to be decimal USDC/],
    ["days without hours", ["--daily", "1", "--per-tx", "1", "--category", "c", "--days", "monday"], /--days and --hours go together/],
    ["a bad weekday", ["--daily", "1", "--per-tx", "1", "--category", "c", "--days", "funday", "--hours", "9-17"], /funday is not a weekday/],
    ["a bad token", ["--daily", "1", "--per-tx", "1", "--category", "c", "--token", "0x12"], /--token: 0x12 is not a 20-byte address/],
  ])("refuses %s before writing anything", async (_label, args, message) => {
    const file = join(dir, "policy.json");
    await expect(run("policy", "init", "--out", file, "--operator", OPERATOR, "--deployment", DEPLOYMENT, "--json", ...args)).rejects.toThrow(message);
    await expect(stat(file)).rejects.toThrow();
  });

  it("does not overwrite a policy file, which holds a secret, without --force", async () => {
    const file = join(dir, "policy.json");
    const args = ["policy", "init", "--out", file, "--operator", OPERATOR, "--daily", "1", "--per-tx", "1", "--category", "c", "--deployment", DEPLOYMENT, "--json"];
    const first = JSON.parse(await run(...args)) as { commitment: string };
    await expect(run(...args)).rejects.toThrow(ValidationError);
    const second = JSON.parse(await run(...args, "--force")) as { commitment: string };
    expect(second.commitment).not.toBe(first.commitment);
  });
});

describe("square policy buyers entry", () => {
  it("issues a buyer the entry the purchase form takes, from the kept list", async () => {
    const buyers = ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"] as const;
    const list = approveBuyers([...buyers]);
    const file = join(dir, "buyers.json");
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ root: list.root, entries: list.entries }));
    const entry = JSON.parse(await run("policy", "buyers", "entry", file, buyers[1])) as { buyer: string; salt: string; proof: string[]; root: string };
    expect(entry).toEqual({ buyer: buyers[1], ...list.eligibilityOf(buyers[1]), root: list.root });
    await expect(run("policy", "buyers", "entry", file, OPERATOR)).rejects.toThrow(/is not on this list/);
  });
});

describe("square policy commit and prove", () => {
  it("refuse a job id that is not one, and a policy file that is not there, before touching the chain", async () => {
    await expect(run("policy", "prove", "abc", "--file", join(dir, "none.json"), "--artifacts", join(dir, "no-artifacts"), "--category", "c")).rejects.toThrow(/abc is not a job id/);
    await expect(run("policy", "commit", join(dir, "none.json"), "--dry-run")).rejects.toThrow(/No policy file at/);
  });
});
