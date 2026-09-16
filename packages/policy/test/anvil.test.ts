import { JobStatus, approveBuyers, hashDeliverable, screeningRegistryAbi, squareHookAbi, type Screener } from "@squaresdk/core";
import { createWalletClient, http, keccak256, parseUnits, stringToHex, zeroAddress, type Address } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComplianceDuty, type DutyEvent } from "../src/duty.js";
import { policyCommitment } from "../src/commitment.js";
import { newPolicy, type Policy } from "../src/policy.js";
import { decodeComplianceProof, signalsOf } from "../src/proof.js";
import { createLocalProver, type LocalProver } from "../src/local-prover.js";
import { bindComplianceProof, moduleVerdict, proofState, releaseFacts } from "../src/release.js";
import { account, artifacts, complianceStack, rpcUrl, type Stack } from "./helpers/stack.js";

/**
 * The institution's side of the gate, end to end on a stack with the module
 * installed, proving in this process from the key the module was keyed to
 * (square#347): a policy committed from here is the one the proof is made
 * against, a proof bound from here is the one the module verifies, and the
 * escrow goes to whoever the proof names. Skipped without the stack
 * (test/helpers/stack.ts).
 */
const ready = await complianceStack();

describe.skipIf(!("stack" in ready))("policy → proof → release, on chain", () => {
  const stack = ("stack" in ready ? ready.stack : undefined) as Stack;
  const prover = ("stack" in ready ? createLocalProver({ artifacts }) : undefined) as LocalProver;
  afterAll(async () => {
    await prover?.close();
  });
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

  describe("on a hook that screens (square#369)", () => {
    const registry = () => stack.deployment.screeningRegistry;
    const owner = () => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(0) });
    const screenerAccount = account(8);
    const send = async (hash: Promise<`0x${string}`>) => stack.publicClient.waitForTransactionReceipt({ hash: await hash });
    // What the screener service does, from a test: a clean record per subject, signed by a registered key and submitted, answered after the receipt.
    const screenerAsked: Address[][] = [];
    const screener: Screener = {
      async screen(subjects) {
        screenerAsked.push([...subjects]);
        const block = await stack.publicClient.getBlock();
        const screenings = subjects.map((subject) => ({ subject, sanctioned: false, screenedAt: block.timestamp, source: keccak256(stringToHex("test-screener")), evidence: keccak256(subject) }));
        const signatures: `0x${string}`[] = [];
        for (const screening of screenings) {
          const digest = await stack.publicClient.readContract({ abi: screeningRegistryAbi, address: registry()!, functionName: "digestOf", args: [screening] });
          signatures.push(await screenerAccount.sign({ hash: digest }));
        }
        const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: screenerAccount });
        await send(wallet.writeContract({ abi: screeningRegistryAbi, address: registry()!, functionName: "submitMany", args: [screenings, signatures] }));
      },
    };

    beforeAll(async () => {
      if (registry() === undefined) return;
      await send(owner().writeContract({ abi: squareHookAbi, address: stack.deployment.squareHook, functionName: "setScreening", args: [registry()!] }));
      await send(owner().writeContract({ abi: screeningRegistryAbi, address: registry()!, functionName: "setScreener", args: [screenerAccount.address, true] }));
    }, 60_000);

    afterAll(async () => {
      if (registry() === undefined) return;
      await send(owner().writeContract({ abi: squareHookAbi, address: stack.deployment.squareHook, functionName: "setScreening", args: [zeroAddress] }));
      await send(owner().writeContract({ abi: screeningRegistryAbi, address: registry()!, functionName: "setScreener", args: [screenerAccount.address, false] }));
    }, 60_000);

    it("holds a payee whose record went stale instead of cranking it into the refusal, releases once a screening lands, and with a screener does both in one tick", async () => {
      if (registry() === undefined) {
        console.warn("the deployment record names no ScreeningRegistry: DeployLocal predates #222, the screening case is not run");
        return;
      }
      const client = institution();
      // Both parties screened, so the hire funds; a day later their records are older than maxAge.
      await screener.screen([account(1).address, account(2).address]);
      const jobId = await submittedJob();
      await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
      await stack.testClient.mine({ blocks: 1 });
      expect(await client.screeningOf(account(2).address)).toMatchObject({ state: "unscreened" });

      const held: DutyEvent[] = [];
      const duty = new ComplianceDuty({ client, policy, prover, onEvent: (e) => held.push(e), discover: false });
      duty.track(jobId, "text.summarize");
      const first = await duty.tick();
      expect(first.bound).toEqual([jobId]);
      expect(first.released).toEqual([]);
      expect(first.held).toMatchObject([{ jobId, payee: account(2).address, reason: expect.stringContaining("no fresh, clean record for the payee") }]);
      expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Submitted);
      const second = await duty.tick();
      expect(second.released).toEqual([]);
      expect(held.filter((e) => e.type === "held")).toHaveLength(1);

      // A screening lands: the next tick releases, and the hook paid the payee.
      await screener.screen([account(2).address]);
      const owed = await provider().withdrawable(account(2).address);
      const third = await duty.tick();
      expect(third.released).toEqual([jobId]);
      expect(held.at(-1)).toMatchObject({ type: "released", jobId, verified: true, payeeCleared: true, payee: account(2).address });
      expect((await provider().withdrawable(account(2).address)) - owed).toBe(await client.netPayout(jobId));

      // The same again with a screener in hand: asked for the payee, released in the same tick.
      await screener.screen([account(1).address, account(2).address]);
      const next = await submittedJob();
      await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
      await stack.testClient.mine({ blocks: 1 });
      screenerAsked.length = 0;
      const asking = new ComplianceDuty({ client, policy, prover, screener, discover: false });
      asking.track(next, "text.summarize");
      const report = await asking.tick();
      expect(report.released).toEqual([next]);
      expect(report.held).toEqual([]);
      expect(screenerAsked).toEqual([[account(2).address]]);
    }, 300_000);
  });

  it("refuses to bind for a release the policy does not allow, naming the rule; a proofless crank is refused and the escrow waits for the client", async () => {
    const jobId = await submittedJob();
    const client = institution();
    const outcome = await bindComplianceProof({ client, policy, prover, jobId, category: "not.allowed" });
    expect(outcome).toMatchObject({ bound: false, reason: "not-compliant", violated: ["endpoint_category"] });
    expect(await client.complianceProofOf(jobId)).toBe("0x");
    // Nothing bound and the window closed. Since square#382 the evaluator does
    // not settle a job it has no verdict for: the crank is refused, the job
    // stays Submitted, nobody is paid and nobody is refunded.
    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    const owed = await provider().withdrawable(account(2).address);
    expect(await client.proofState(jobId)).toBe("missing");
    await expect(stack.actor(4).finalize(jobId)).rejects.toThrow(/ProofRequired/);
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Submitted);
    expect(await provider().withdrawable(account(2).address)).toBe(owed);
    // The client, and only the client, ends the wait: a proof for the release
    // the policy does allow settles the job, and the provider is paid.
    const bound = await bindComplianceProof({ client, policy, prover, jobId, category: "text.summarize" });
    expect(bound.bound).toBe(true);
    expect(await client.proofState(jobId)).toBe("decidable");
    const result = await stack.actor(4).finalize(jobId);
    expect(result.receipt.status).toBe("success");
    expect(moduleVerdict(result.receipt, stack.deployment.complianceModule!)).toEqual({ verified: true });
    expect(await provider().withdrawable(account(2).address)).toBeGreaterThan(owed);
  }, 180_000);

  // square#396. A job the mandate refuses on a rule that stands: the duty binds
  // the refusal itself, the module pronounces it at release, and the net comes
  // back to the institution instead of waiting in escrow forever.
  it("binds the mandate's refusal for a job bought under a category the policy does not allow, and the release returns the net to the institution", async () => {
    const jobId = await submittedJob();
    const client = institution();
    const duty = new ComplianceDuty({ client, policy, prover, onEvent: (e) => events.push(e), discover: false });
    duty.track(jobId, "not.allowed");
    await stack.testClient.increaseTime({ seconds: 86_400 + 1 });
    await stack.testClient.mine({ blocks: 1 });
    const owedToProvider = await provider().withdrawable(account(2).address);
    const owedToClient = await client.withdrawable(account(1).address);
    const report = await duty.tick();
    expect(report.refusalBound).toEqual([jobId]);
    expect(report.released).toEqual([jobId]);
    expect(events.find((e) => e.type === "refusal-bound" && e.jobId === jobId)).toMatchObject({ violated: ["endpoint_category"] });
    const released = events.find((e) => e.type === "released" && e.jobId === jobId);
    expect(released).toMatchObject({ type: "released", verified: false, refusedFor: stringToHex("is_compliant is 0", { size: 32 }) });
    expect((await client.getJobRecord(jobId)).status).toBe(JobStatus.Completed);
    expect(await provider().withdrawable(account(2).address)).toBe(owedToProvider);
    expect((await client.withdrawable(account(1).address)) - owedToClient).toBe(await client.netPayout(jobId));
    expect(duty.jobs()).toEqual([]);
  }, 180_000);
});
