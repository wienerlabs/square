import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSquareClient, deploymentFor, deploymentFromJson, hashDeliverable, JobStatus, type SquareDeployment } from "@squaresdk/core";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { buildProgram } from "../src/cli.js";

/**
 * `square policy` against the compliance stack (packages/policy/test/helpers/stack.ts):
 * init, commit, show, buyers, prove, status and release, unattended with
 * SQUARE_PRIVATE_KEY the way CI runs the CLI. Skipped without the stack.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const artifacts = process.env["SQUARE_PROVER_ARTIFACTS"] ?? process.env["PROVER_ARTIFACTS_DIR"] ?? join(HERE, "..", "..", "..", "services", "prover", "artifacts");
const DEPLOYMENT_FILE = process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(HERE, "..", "..", "..", "contracts", "deployments", "31337.json");
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const key = (index: number) => `0x${Buffer.from(account(index).getHdKey().privateKey!).toString("hex")}`;

async function json(url: string, body?: string): Promise<unknown> {
  try {
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body } : {}) });
    return await response.json();
  } catch {
    return null;
  }
}
function localDeployment(): SquareDeployment {
  return existsSync(DEPLOYMENT_FILE) ? deploymentFromJson(JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"))) : deploymentFor(31337);
}
async function complianceStackReady(): Promise<string | null> {
  if ((await json(rpcUrl, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })) as { result?: string } | null)?.result !== "0x7a69") return `no anvil at ${rpcUrl}`;
  if (!["payment.wasm", "payment.zkey", "payment_vk.json"].every((file) => existsSync(join(artifacts, file)))) return `no proving artifacts at ${artifacts}`;
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  if ((await createSquareClient({ publicClient, deployment: localDeployment() }).complianceModule()) === null) return `no compliance module on the stack at ${rpcUrl}`;
  return null;
}
const notReady = await complianceStackReady();

describe.skipIf(notReady !== null)("square policy, on the compliance stack", () => {
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const wallet = (index: number) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index) });
  const institution = createSquareClient({ publicClient, deployment, walletClient: wallet(1) });
  const provider = createSquareClient({ publicClient, deployment, walletClient: wallet(2) });
  // The deployment file names the chain and its registry; only the endpoint is the flag's.
  const network = ["--rpc", rpcUrl, "--deployment", DEPLOYMENT_FILE];
  let dir: string;
  let policyFile: string;
  let jobId: bigint;
  const previousKey = process.env["SQUARE_PRIVATE_KEY"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "square-cli-policy-"));
    policyFile = join(dir, "policy.json");
    process.env["SQUARE_PRIVATE_KEY"] = key(1);
    const pending = await publicClient.getBlock({ blockTag: "pending" });
    ({ jobId } = await institution.createJob({ provider: account(2).address, expiredAt: pending.timestamp + 30n * 86_400n, spec: { task: "summarise" } }));
    await provider.setBudget(jobId, parseUnits("5", 6));
    // Funded in the prove test, once the policy is committed: the hook pins the
    // client's commitment at funding and the release is proved under that one
    // (square#382), so a job funded before `commit` could only be proved under
    // whatever the client had committed before.
  }, 60_000);

  afterAll(() => {
    if (previousKey === undefined) delete process.env["SQUARE_PRIVATE_KEY"];
    else process.env["SQUARE_PRIVATE_KEY"] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  });

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
  const parse = <T>(text: string): T => JSON.parse(text) as T;

  it("init, commit, show: the file's commitment is the one the chain holds", async () => {
    const init = parse<{ commitment: string }>(await run("policy", "init", "--out", policyFile, "--daily", "50", "--per-tx", "10", "--category", "text.summarize", ...network, "--json"));
    const dry = parse<{ dryRun: boolean; committed: boolean; commitment: string }>(await run("policy", "commit", policyFile, "--dry-run", ...network, "--json"));
    expect(dry).toMatchObject({ dryRun: true, commitment: init.commitment, committed: false });
    const committed = parse<{ status: string; transaction: string; epoch: string }>(await run("policy", "commit", policyFile, "--yes", ...network, "--json"));
    expect(committed).toMatchObject({ status: "committed", commitment: init.commitment });
    const again = parse<{ status: string }>(await run("policy", "commit", policyFile, "--yes", ...network, "--json"));
    expect(again.status).toBe("unchanged");
    const shown = parse<{ poster: string; commitment: string; committed: boolean; dailyLimit: string; fileMatches: boolean; complianceModule: string | null }>(
      await run("policy", "show", "--file", policyFile, ...network, "--json"),
    );
    expect(shown).toMatchObject({ poster: account(1).address, commitment: init.commitment, committed: true, dailyLimit: "50000000", fileMatches: true });
    expect(shown.complianceModule).not.toBeNull();
  }, 60_000);

  it("buyers set publishes the root and keeps the entries; entry hands a buyer its path", async () => {
    const buyersFile = join(dir, "buyers.json");
    const set = parse<{ status: string; root: string; buyers: string[] }>(await run("policy", "buyers", "set", account(3).address, account(4).address, "--out", buyersFile, "--yes", ...network, "--json"));
    expect(set).toMatchObject({ status: "published", buyers: [account(3).address, account(4).address] });
    expect(await institution.buyerRootOf(account(1).address)).toBe(set.root);
    const entry = parse<{ buyer: string; salt: string; proof: string[]; root: string }>(await run("policy", "buyers", "entry", buyersFile, account(3).address));
    expect(entry).toMatchObject({ buyer: account(3).address, root: set.root });
    expect(entry.proof).toHaveLength(1);
  }, 60_000);

  it("prove binds a proof for the job's release, status reads it back, and release cranks once the window closes", async () => {
    await institution.fund(jobId, parseUnits("5", 6));
    await provider.submit({ jobId, deliverable: hashDeliverable(`cli ${jobId}`), agentId: 1n });
    const bound = parse<{ bound: boolean; transaction: string; facts: { payee: string } }>(await run("policy", "prove", jobId.toString(), "--file", policyFile, "--artifacts", artifacts, "--category", "text.summarize", ...network, "--json"));
    expect(bound).toMatchObject({ bound: true, facts: { payee: account(2).address } });
    expect(await institution.complianceProofOf(jobId)).not.toBe("0x");
    const status = parse<{ module: boolean; state: { kind: string }; signals: { recipient: string } }>(await run("policy", "status", jobId.toString(), ...network, "--json"));
    expect(status).toMatchObject({ module: true, state: { kind: "current" } });
    expect(status.signals.recipient.toLowerCase()).toBe(account(2).address.toLowerCase());

    await expect(run("policy", "prove", jobId.toString(), "--file", policyFile, "--artifacts", artifacts, "--category", "not.allowed", ...network, "--json")).rejects.toThrow(/does not allow this release: endpoint_category/);

    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    const owed = await provider.withdrawable(account(2).address);
    const net = await institution.netPayout(jobId);
    const released = parse<{ report: { bound: string[]; released: string[] }; events: { type: string; verified?: boolean }[] }>(
      await run("policy", "prove", jobId.toString(), "--release", "--file", policyFile, "--artifacts", artifacts, "--category", "text.summarize", ...network, "--json"),
    );
    expect(released.report.released).toEqual([jobId.toString()]);
    expect(released.events.find((e) => e.type === "released")).toMatchObject({ verified: true });
    expect((await institution.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
    expect((await provider.withdrawable(account(2).address)) - owed).toBe(net);
  }, 180_000);

  // square#396: a job with no proof does not settle, so the mandate's refusal
  // is bound on purpose and the release returns the net to the institution.
  it("prove --bind-refusal binds the policy's refusal, and the release returns the net to the institution", async () => {
    const pending = await publicClient.getBlock({ blockTag: "pending" });
    const { jobId: refused } = await institution.createJob({ provider: account(2).address, expiredAt: pending.timestamp + 30n * 86_400n, spec: { task: "translate" } });
    await provider.setBudget(refused, parseUnits("5", 6));
    await institution.fund(refused, parseUnits("5", 6));
    await provider.submit({ jobId: refused, deliverable: hashDeliverable(`cli ${refused}`), agentId: 1n });
    const bound = parse<{ bound: boolean; verdict: string; violated: string[] }>(
      await run("policy", "prove", refused.toString(), "--file", policyFile, "--artifacts", artifacts, "--category", "not.allowed", "--bind-refusal", ...network, "--json"),
    );
    expect(bound).toMatchObject({ bound: true, verdict: "refusal", violated: ["endpoint_category"] });
    const status = parse<{ state: { kind: string; reasons?: string[] }; facts: { pinnedCommitment: string | null } }>(await run("policy", "status", refused.toString(), ...network, "--json"));
    expect(status.state.kind).toBe("stale");
    expect(status.state.reasons?.join(" ")).toMatch(/not compliant/);
    expect(status.facts.pinnedCommitment).not.toBeNull();

    await testClient.increaseTime({ seconds: 86_400 + 1 });
    await testClient.mine({ blocks: 1 });
    const owedToProvider = await provider.withdrawable(account(2).address);
    const owedToClient = await institution.withdrawable(account(1).address);
    await institution.finalize(refused);
    expect((await institution.getJobRecord(refused)).status).toBe(JobStatus.Completed);
    expect(await provider.withdrawable(account(2).address)).toBe(owedToProvider);
    expect((await institution.withdrawable(account(1).address)) - owedToClient).toBe(await institution.netPayout(refused));
  }, 180_000);
});
