import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { policyCommitment } from "../src/commitment.js";
import { ARTIFACT_FILES, circuitInput, createLocalProver, evaluateRules } from "../src/local-prover.js";
import { MIN_POLICY_SALT, parsePolicy, type Policy } from "../src/policy.js";
import { encodeComplianceProof, decodeComplianceProof, signalsOf } from "../src/proof.js";
import { proveRequest, type ProveRequest } from "../src/prover.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROVER = join(REPO, "services", "prover", "src");
const proverInstalled = existsSync(join(REPO, "services", "prover", "node_modules", "circomlibjs"));
/** The directory the compliance stack's module is keyed to (scripts/install-module-for-this-build.mjs reads the same one). */
const ARTIFACTS = process.env["SQUARE_PROVER_ARTIFACTS"] ?? process.env["PROVER_ARTIFACTS_DIR"] ?? join(REPO, "services", "prover", "artifacts");
const haveArtifacts = Object.values(ARTIFACT_FILES).every((file) => existsSync(join(ARTIFACTS, file)));

const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const PAYEE = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const BLOCKED = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
// Tuesday 2027-01-05 13:00:00 UTC.
const TUESDAY_1PM = 1_799_154_000n;

const policy = (overrides: Partial<Policy> = {}): Policy =>
  parsePolicy({
    policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
    policy_salt: (MIN_POLICY_SALT + 424242n).toString(),
    operator_id: OPERATOR,
    max_daily_spend: "100000",
    max_per_transaction: "50000",
    allowed_endpoint_categories: ["api-call", "text.summarize"],
    blocked_addresses: [BLOCKED],
    token_whitelist: [USDC],
    ...overrides,
  });

const payment = (overrides: Partial<{ recipient: `0x${string}`; amount: bigint; token: `0x${string}`; category: string; dailySpentBefore: bigint; timestamp: bigint }> = {}) => ({
  recipient: PAYEE,
  amount: 10_000n,
  token: USDC,
  category: "api-call",
  dailySpentBefore: 0n,
  timestamp: TUESDAY_1PM,
  ...overrides,
});

const WINDOW = { time_restrictions: [{ allowed_days: ["monday", "tuesday"], allowed_hours_start: 9, allowed_hours_end: 17 }] } as Partial<Policy>;

// Each request, and the rules the prover names for it.
const CASES: Array<[string, ProveRequest, string[]]> = [
  ["a compliant release", proveRequest(policy(), payment()), []],
  ["a compliant release inside a window", proveRequest(policy(WINDOW), payment()), []],
  ["a release outside the window", proveRequest(policy(WINDOW), payment({ timestamp: TUESDAY_1PM + 5n * 3_600n })), ["time_window"]],
  ["a release over both ceilings", proveRequest(policy(), payment({ amount: 60_000n, dailySpentBefore: 50_000n })), ["per_transaction_limit", "daily_limit"]],
  ["a release to a blocked payee in another token", proveRequest(policy(), payment({ recipient: BLOCKED, token: PAYEE })), ["token_whitelist", "blocked_recipient"]],
  ["a release for a category the policy does not pay", proveRequest(policy(), payment({ category: "not.allowed" })), ["endpoint_category"]],
  [
    "full lists",
    proveRequest(
      policy({ allowed_endpoint_categories: Array.from({ length: 8 }, (_, i) => `cat-${i}`), blocked_addresses: Array.from({ length: 10 }, () => BLOCKED), token_whitelist: Array.from({ length: 10 }, () => USDC) }),
      payment({ category: "cat-7" }),
    ),
    [],
  ],
];

describe("the circuit input, built in this process", () => {
  it.each(CASES)("names the rules %s breaks", async (_label, request, violated) => {
    expect(evaluateRules(await circuitInput(request)).violated).toEqual(violated);
  });

  it.each([
    ["a zero payee", { ...proveRequest(policy(), payment()), payment_recipient: "0x0000000000000000000000000000000000000000" }, /payment_recipient: must not be the zero address/],
    ["a token that is not an address", { ...proveRequest(policy(), payment()), payment_token: "usdc" }, /payment_token: must be a 20-byte hex address/],
    ["an empty category", proveRequest(policy(), payment({ category: "" })), /payment_endpoint_category: must be a string of 1 to 32 bytes/],
    ["a guessable salt", { ...proveRequest(policy(), payment()), policy_salt: "1" }, /policy_salt: must be at least 2\^128/],
    ["a negative amount", { ...proveRequest(policy(), payment()), payment_amount: "-1" }, /payment_amount: must be a non-negative integer/],
  ])("refuses %s, by the field's name", async (_label, request, message) => {
    await expect(circuitInput(request as ProveRequest)).rejects.toMatchObject({ name: "ProverError", message });
  });

  it("names every missing file of a proving directory, before anything is proved", () => {
    const empty = mkdtempSync(join(tmpdir(), "square-no-artifacts-"));
    expect(() => createLocalProver({ artifacts: empty })).toThrow(/no proving artifacts at .*: payment\.wasm, payment\.zkey, payment_vk\.json missing/);
  });
});

describe.skipIf(!proverInstalled)("against the prover's own construction", () => {
  // services/prover/src/prover.js builds the input the circuit is proved on and
  // rules.js names the rules; the circuit's tests hold those two to the circuit.
  // This holds the local prover to them, so a proof made here is the proof the
  // service would have made from the same request.
  it.each(CASES)("builds the prover's circuit input and names its rules for %s", async (_label, request) => {
    const { buildCircuitInput } = (await import(pathToFileURL(join(PROVER, "prover.js")).href)) as { buildCircuitInput: (r: unknown) => Promise<Record<string, unknown>> };
    const { evaluateRules: proverRules } = (await import(pathToFileURL(join(PROVER, "rules.js")).href)) as { evaluateRules: (i: unknown) => Promise<{ compliant: boolean; violated: string[] }> };
    const theirs = await buildCircuitInput(request);
    const ours = await circuitInput(request);
    expect(ours).toEqual(theirs);
    expect(evaluateRules(ours)).toEqual(await proverRules(theirs));
  }, 30_000);
});

describe.skipIf(!haveArtifacts)("a real proof, made here", () => {
  const prover = haveArtifacts ? createLocalProver({ artifacts: ARTIFACTS }) : null;
  afterAll(async () => {
    await prover?.close();
  });

  it("proves a compliant release under the policy's own commitment, checked against payment_vk.json", async () => {
    const p = policy();
    const response = await prover!.prove(proveRequest(p, payment()));
    expect(response.is_compliant).toBe(true);
    expect(response.violated_rules).toEqual([]);
    expect(BigInt(response.policy_data_hash)).toBe((await policyCommitment(p)).root);
    const signals = signalsOf(decodeComplianceProof(encodeComplianceProof(response.solidity))!);
    expect(signals).toMatchObject({ isCompliant: true, recipient: PAYEE.toLowerCase(), amount: 10_000n, token: USDC.toLowerCase(), dailySpentBefore: 0n, timestamp: TUESDAY_1PM });
  }, 60_000);

  it("proves a refused release too, and names the rule", async () => {
    const response = await prover!.prove(proveRequest(policy(), payment({ category: "not.allowed" })));
    expect(response.is_compliant).toBe(false);
    expect(response.violated_rules).toEqual(["endpoint_category"]);
  }, 60_000);

  it("refuses to hand back a proof its verification key does not accept, and says the files are from different keys", async () => {
    // The same wasm and zkey beside a verification key whose IC points are
    // swapped: every point still on the curve, and the key no longer this zkey's.
    const dir = mkdtempSync(join(tmpdir(), "square-other-key-"));
    for (const file of [ARTIFACT_FILES.wasm, ARTIFACT_FILES.zkey]) copyFileSync(join(ARTIFACTS, file), join(dir, file));
    const vk = JSON.parse(readFileSync(join(ARTIFACTS, ARTIFACT_FILES.verificationKey), "utf8")) as { IC: unknown[] };
    [vk.IC[1], vk.IC[2]] = [vk.IC[2], vk.IC[1]];
    writeFileSync(join(dir, ARTIFACT_FILES.verificationKey), JSON.stringify(vk));
    const other = createLocalProver({ artifacts: dir });
    try {
      await expect(other.prove(proveRequest(policy(), payment()))).rejects.toThrow(/does not verify against .*payment_vk\.json: payment\.zkey and payment_vk\.json come from different keys/);
    } finally {
      await other.close();
    }
  }, 60_000);
});
