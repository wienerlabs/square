import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { ComplianceDuty, type DutyEvent } from "../src/duty.js";
import { policyCommitment } from "../src/commitment.js";
import { MIN_POLICY_SALT, parsePolicy } from "../src/policy.js";
import { bindComplianceProof, proofState, releaseFacts } from "../src/release.js";
import { BUYER, CLIENT, fakeChain, fundedJob, PROVIDER, proofWith, USDC, ZERO32 } from "./helpers/fakeChain.js";

const policy = parsePolicy({
  policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
  policy_salt: (MIN_POLICY_SALT + 424242n).toString(),
  operator_id: CLIENT,
  max_daily_spend: "5000000",
  max_per_transaction: "1000000",
  allowed_endpoint_categories: ["text.summarize"],
  blocked_addresses: [],
  token_whitelist: [USDC],
});
const commitment = await policyCommitment(policy);

describe("proofState", () => {
  it("is current when every signal matches the release the chain would make now", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now + 100n }));
    const facts = await releaseFacts(chain.client, 7n);
    const proof = proofWith({ commitment: commitment.hex, recipient: PROVIDER, amount: 985_000n, spent: 0n, timestamp: chain.now - 10n });
    expect(proofState(proof, facts, 1_800n)).toMatchObject({ kind: "current", age: 10n });
  });

  it.each([
    ["the payee moved to a buyer", { recipient: BUYER }, /the payee is/],
    ["the net changed", { amount: 900_000n }, /the net is 985000, the proof names 900000/],
    ["the day's counter moved", { spent: 5n }, /the day's counter is 0, the proof names 5/],
    ["the proof aged past the refresh point", { timestamp: 1_800_000_000n - 1_801n }, /1801s old/],
    ["the policy was recommitted", { commitment: `0x${"1".repeat(64)}` as const }, /commitment changed/],
    ["the circuit said not compliant", { compliant: false }, /not compliant/],
  ])("is stale when %s", async (_label, overrides, reason) => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    const facts = await releaseFacts(chain.client, 7n);
    const proof = proofWith({ commitment: commitment.hex, recipient: PROVIDER, amount: 985_000n, spent: 0n, timestamp: chain.now, ...overrides });
    const state = proofState(proof, facts, 1_800n);
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.reasons.join("; ")).toMatch(reason);
  });

  it("is none for an empty slot and malformed for bytes of the wrong length", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    const facts = await releaseFacts(chain.client, 7n);
    expect(proofState("0x", facts, 1n)).toEqual({ kind: "none" });
    expect(proofState("0x1234", facts, 1n)).toEqual({ kind: "malformed" });
  });
});

describe("bindComplianceProof", () => {
  it("proves against the release as it stands and binds the bytes", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    chain.spent = 1_000n;
    const outcome = await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "text.summarize" });
    expect(outcome.bound).toBe(true);
    expect(chain.writes).toEqual(["setComplianceProof(7)"]);
    expect(chain.proofs[0]).toMatchObject({ payment_recipient: PROVIDER, payment_amount: "985000", daily_spent_before: "1000", payment_endpoint_category: "text.summarize", payment_token: USDC });
    expect(chain.jobs.get("7")!.proof).not.toBe("0x");
  });

  it("refuses before proving when the chain holds no policy, or a different one", async () => {
    const none = fakeChain({ commitment: ZERO32 });
    none.jobs.set("7", fundedJob());
    expect(await bindComplianceProof({ client: none.client, policy, prover: none.prover, jobId: 7n, category: "text.summarize" })).toMatchObject({ bound: false, reason: "policy-not-committed" });
    const other = fakeChain({ commitment: `0x${"a".repeat(64)}` });
    other.jobs.set("7", fundedJob());
    expect(await bindComplianceProof({ client: other.client, policy, prover: other.prover, jobId: 7n, category: "text.summarize" })).toMatchObject({ bound: false, reason: "policy-differs" });
    expect(none.proofs).toHaveLength(0);
    expect(other.proofs).toHaveLength(0);
  });

  it("reports a non-compliant release with the rules it broke, and binds nothing", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ net: 2_000_000n }));
    const outcome = await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "text.summarize" });
    expect(outcome).toMatchObject({ bound: false, reason: "not-compliant", violated: ["per_transaction_limit"] });
    expect(chain.writes).toEqual([]);
  });

  it("refuses a job of another client, and a settled one", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ client: BUYER }));
    chain.jobs.set("8", fundedJob({ status: JobStatus.Completed }));
    expect(await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "x" })).toMatchObject({ bound: false, reason: "not-this-client" });
    expect(await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 8n, category: "x" })).toMatchObject({ bound: false, reason: "terminal" });
  });

  it("does not bind a proof the module itself refuses", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    chain.judge = () => false;
    expect(await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "text.summarize" })).toMatchObject({ bound: false, reason: "module-refuses" });
    expect(chain.writes).toEqual([]);
  });
});

describe("ComplianceDuty", () => {
  const duty = (chain: ReturnType<typeof fakeChain>, events: DutyEvent[] = []) =>
    new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, onEvent: (e) => events.push(e) });

  it("binds a proof to a funded job, leaves it while current, and rebinds when the release moves", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    expect(await d.tick()).toMatchObject({ bound: [7n], current: [], released: [] });
    expect(await d.tick()).toMatchObject({ bound: [], current: [7n] });
    chain.spent = 3n; // another release of the day moved the counter
    expect(await d.tick()).toMatchObject({ bound: [7n] });
    expect(events.filter((e) => e.type === "bound").map((e) => (e.type === "bound" ? e.because : []))).toEqual([["no proof is bound"], ["the day's counter is 3, the proof names 0"]]);
  });

  it("rebinds when the proof ages past half the module's tolerance", async () => {
    const chain = fakeChain({ commitment: commitment.hex, tolerance: 600n });
    chain.jobs.set("7", fundedJob());
    const d = duty(chain);
    d.track(7n, "text.summarize");
    await d.tick();
    chain.now += 299n;
    expect(await d.tick()).toMatchObject({ current: [7n] });
    chain.now += 2n;
    expect(await d.tick()).toMatchObject({ bound: [7n] });
  });

  it("releases the job itself once the window closes, and the module verifies the proof it bound", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now + 50n }));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    expect(await d.tick()).toMatchObject({ bound: [7n], released: [] });
    chain.now += 60n;
    expect(await d.tick()).toMatchObject({ current: [7n], released: [7n] });
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7)"]);
    expect(chain.spent).toBe(985_000n);
    expect(d.jobs()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "released", jobId: 7n, payee: PROVIDER, amount: 985_000n });
  });

  it("rebinds for the buyer of a sold receivable before releasing to it", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now + 50n }));
    const d = duty(chain);
    d.track(7n, "text.summarize");
    await d.tick();
    chain.jobs.get("7")!.payee = BUYER;
    chain.now += 60n;
    const report = await d.tick();
    expect(report).toMatchObject({ bound: [7n], released: [7n] });
    expect(chain.proofs.at(-1)).toMatchObject({ payment_recipient: BUYER });
    expect(chain.writes.at(-1)).toBe("finalize(7)");
  });

  it("proves the arbiters' split for a decided dispute, and applies the decision itself", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now - 1n, disputed: true, outcome: 2, providerBps: 4_000 }));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    expect(await d.tick()).toMatchObject({ bound: [7n], released: [7n] });
    expect(chain.proofs.at(-1)).toMatchObject({ payment_amount: "394000" });
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalizeDecided(7)"]);
    expect(events.at(-1)).toMatchObject({ type: "released", amount: 394_000n });
  });

  it("does not crank a disputed job, and stops tracking one another hand settled", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now - 1n, disputed: true }));
    chain.jobs.set("8", fundedJob({ status: JobStatus.Completed }));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    d.track(8n, "text.summarize");
    expect(await d.tick()).toMatchObject({ bound: [7n], released: [], settled: [8n] });
    expect(chain.writes).toEqual(["setComplianceProof(7)"]);
    expect(d.jobs().map((j) => j.jobId)).toEqual([7n]);
    expect(events.find((e) => e.type === "settled")).toMatchObject({ jobId: 8n, status: JobStatus.Completed });
  });

  it("reports a refusal once until it changes, and keeps the job", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ net: 2_000_000n }));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    expect((await d.tick()).refused).toEqual([{ jobId: 7n, reason: "not-compliant: not compliant: per_transaction_limit" }]);
    await d.tick();
    expect(events.filter((e) => e.type === "refused")).toHaveLength(1);
    expect(d.jobs()).toHaveLength(1);
  });

  it("does nothing on a stack without a module, and says so once", async () => {
    const chain = fakeChain({ commitment: commitment.hex, module: null });
    chain.jobs.set("7", fundedJob());
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    await d.tick();
    await d.tick();
    expect(chain.writes).toEqual([]);
    expect(events).toEqual([{ type: "no-module" }]);
  });

  it("takes a keeper's crank in its stride: a finalize that reverts on a Completed job is a settlement", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now - 1n }));
    const d = duty(chain);
    d.track(7n, "text.summarize");
    const original = chain.client.finalize.bind(chain.client);
    chain.client.finalize = async (id: bigint) => {
      chain.jobs.get(id.toString())!.status = JobStatus.Completed; // the keeper landed first
      throw new Error("NotSubmitted()");
    };
    expect(await d.tick()).toMatchObject({ bound: [7n], released: [], settled: [7n], errors: [] });
    chain.client.finalize = original;
  });

  it("runs on a cadence until aborted", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    const d = duty(chain);
    d.track(7n, "text.summarize");
    const controller = new AbortController();
    const done = d.run(controller.signal, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await done;
    expect(chain.writes).toEqual(["setComplianceProof(7)"]);
  });
});
