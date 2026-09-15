import { JobStatus, approveBuyers, hashDeliverable } from "@squaresdk/core";
import { parseUnits } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { ComplianceDuty, type DutyEvent } from "../src/duty.js";
import { policyCommitment } from "../src/commitment.js";
import { newPolicy, type Policy } from "../src/policy.js";
import { decodeComplianceProof, signalsOf } from "../src/proof.js";
import { createProverClient } from "../src/prover.js";
import { bindComplianceProof, proofState, releaseFacts } from "../src/release.js";
import { account, complianceStack, proverUrl, type Stack } from "./helpers/stack.js";

/**
 * The institution's side of the gate, end to end on a stack with the module
 * installed and a real prover beside it: a policy committed from here is the
 * one the prover proves against, a proof bound from here is the one the
 * module verifies, and the escrow goes to whoever the proof names. Skipped
 * without the stack (test/helpers/stack.ts).
 */
const ready = await complianceStack();

describe.skipIf(!("stack" in ready))("policy → proof → release, on chain", () => {
  const stack = ("stack" in ready ? ready.stack : undefined) as Stack;
  const prover = createProverClient({ url: proverUrl });
  // anvil 1 is the institution, anvil 2 owns mock agent 1 (the provider), anvil 3 buys receivables.
  const institution = () => stack.actor(1);
  const provider = () => stack.actor(2);
  const buyer = () => stack.actor(3);
  const budget = parseUnits("5", 6);
  let policy: Policy;
  const events: DutyEvent[] = [];

  beforeAll(async () => {
    policy = newPolicy({
      operator: account(1).address,
      maxDailySpend: parseUnits("50", 6),
      maxPerTransaction: parseUnits("10", 6),
      categories: ["text.summarize"],
      tokens: [stack.deployment.usdc],
    });
    const commitment = await policyCommitment(policy);
    await institution().setPolicy(commitment.hex, BigInt(policy.max_daily_spend));
    expect((await institution().policyOf(account(1).address)).commitment).toBe(commitment.hex);
  }, 60_000);

  async function submittedJob(): Promise<bigint> {
    const client = institution();
    const pending = await stack.publicClient.getBlock({ blockTag: "pending" });
    const { jobId } = await client.createJob({ provider: account(2).address, expiredAt: pending.timestamp + 30n * 86_400n, spec: { task: "summarise" } });
    await provider().setBudget(jobId, budget);
    await client.fund(jobId, budget);
    await provider().submit({ jobId, deliverable: hashDeliverable(`deliverable ${jobId}`), agentId: 1n });
    return jobId;
  }

  it("waits while the window has a day to run, then binds a real proof the module verifies and releases the net to the provider", async () => {
    const jobId = await submittedJob();
    const client = institution();
    const duty = new ComplianceDuty({ client, policy, prover, onEvent: (e) => events.push(e) });
    duty.track(jobId, "text.summarize");

    // A day to the close and an hour's tolerance: nothing to bind yet (square#349).
    const first = await duty.tick();
    expect(first).toMatchObject({ waiting: [jobId], bound: [], released: [] });
    expect(await client.complianceProofOf(jobId)).toBe("0x");

    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    // The window closed: one bind, one finalize.
    const second = await duty.tick();
    expect(second.bound).toEqual([jobId]);
    expect(second.released).toEqual([jobId]);
    const net = await client.netPayout(jobId);
    const released = events.find((e) => e.type === "released" && e.jobId === jobId);
    expect(released).toMatchObject({ type: "released", verified: true, payee: account(2).address, amount: net });
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
    expect(await provider().withdrawable(account(2).address)).toBeGreaterThanOrEqual(net);
    expect(await client.spentToday(account(1).address)).toBeGreaterThanOrEqual(net);
    expect(duty.jobs()).toEqual([]);
    // The proof the crank consumed named this payee and this net, and was compliant.
    const bound = events.filter((e) => e.type === "bound" && e.jobId === jobId);
    expect(bound).toHaveLength(1);
  }, 180_000);

  it("finds a job it was never told about on the chain, and releases it under the category the proof resolves", async () => {
    const jobId = await submittedJob();
    const client = institution();
    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    // A duty that starts after the hire, with no state file: the chain is what it has (square#348).
    const fresh = new ComplianceDuty({ client, policy, prover, onEvent: (e) => events.push(e) });
    const recovered = await fresh.recover();
    expect(recovered.discovered).toContain(jobId);
    expect(fresh.jobs().find((j) => j.jobId === jobId)).toEqual({ jobId, category: undefined });
    const report = await fresh.tick();
    expect(report.released).toContain(jobId);
    const signals = signalsOf(decodeComplianceProof(await client.complianceProofOf(jobId))!);
    expect(signals.isCompliant).toBe(true);
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
  }, 240_000);

  it("names the buyer of a sold receivable as the payee, and the module releases to the buyer", async () => {
    const jobId = await submittedJob();
    const client = institution();
    // The institution approves the buyer, the provider lists, the buyer buys.
    const list = approveBuyers([account(3).address]);
    await client.setBuyerRoot(list.root);
    const price = parseUnits("4", 6);
    await provider().listClaim(jobId, price);
    await buyer().buyClaim(jobId, list.eligibilityOf(account(3).address));
    expect((await client.payeeOf(jobId)).toLowerCase()).toBe(account(3).address.toLowerCase());

    const outcome = await bindComplianceProof({ client, policy, prover, jobId, category: "text.summarize" });
    expect(outcome.bound).toBe(true);
    if (!outcome.bound) return;
    expect(signalsOf(decodeComplianceProof(outcome.proof)!).recipient.toLowerCase()).toBe(account(3).address.toLowerCase());
    const facts = await releaseFacts(client, jobId);
    expect(proofState(outcome.proof, facts, 1_800n).kind).toBe("current");

    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    const duty = new ComplianceDuty({ client, policy, prover, onEvent: (e) => events.push(e), discover: false });
    duty.track(jobId, "text.summarize");
    const before = await buyer().withdrawable(account(3).address);
    const report = await duty.tick();
    expect(report.released).toEqual([jobId]);
    expect(events.filter((e) => e.type === "released" && e.jobId === jobId)).toMatchObject([{ verified: true, payee: account(3).address }]);
    expect((await buyer().withdrawable(account(3).address)) - before).toBe(facts.amount);
  }, 240_000);

  it("refuses to bind for a release the policy does not allow, naming the rule, and the module refuses a proofless release", async () => {
    const jobId = await submittedJob();
    const client = institution();
    const outcome = await bindComplianceProof({ client, policy, prover, jobId, category: "not.allowed" });
    expect(outcome).toMatchObject({ bound: false, reason: "not-compliant", violated: ["endpoint_category"] });
    expect(await client.complianceProofOf(jobId)).toBe("0x");
    // Nothing bound and the window closed: a crank releases nothing to the provider.
    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    const owed = await provider().withdrawable(account(2).address);
    const result = await stack.actor(4).finalize(jobId);
    expect(result.receipt.status).toBe("success");
    expect(await provider().withdrawable(account(2).address)).toBe(owed);
  }, 180_000);
});
