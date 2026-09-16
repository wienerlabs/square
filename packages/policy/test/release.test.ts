import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { ComplianceDuty, type DutyEvent, type DutyState, type TrackedJob } from "../src/duty.js";
import { policyCommitment } from "../src/commitment.js";
import { MIN_POLICY_SALT, parsePolicy } from "../src/policy.js";
import { bindComplianceProof, proofState, refusalIsTransient, releaseFacts } from "../src/release.js";
import { BUYER, CLIENT, fakeChain, fundedJob, PROVIDER, proofWith, REGISTRY, USDC, ZERO32 } from "./helpers/fakeChain.js";

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
// The policy the client commits after funding under the first: same rules, another salt.
const rotated = parsePolicy({ ...policy, policy_id: "0b2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", policy_salt: (MIN_POLICY_SALT + 777777n).toString() });
const rotatedCommitment = await policyCommitment(rotated);

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

  // square#396. The hook pins the client's commitment at funding (square#382)
  // and the module binds the proof to the pin, whatever the client committed since.
  it("proves against the commitment pinned at funding, and names the pin when the file is the policy committed since", async () => {
    const chain = fakeChain({ commitment: rotatedCommitment.hex });
    chain.jobs.set("7", fundedJob({ pinned: commitment.hex }));
    const facts = await releaseFacts(chain.client, 7n);
    expect(facts).toMatchObject({ commitment: commitment.hex, liveCommitment: rotatedCommitment.hex, pinnedCommitment: commitment.hex });
    const withTheNewFile = await bindComplianceProof({ client: chain.client, policy: rotated, prover: chain.prover, jobId: 7n, category: "text.summarize" });
    expect(withTheNewFile).toMatchObject({ bound: false, reason: "policy-pinned" });
    expect("detail" in withTheNewFile ? withTheNewFile.detail : "").toMatch(/funded under commitment 0x.*prove --file/);
    expect(chain.proofs).toHaveLength(0);
    const withTheOldFile = await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "text.summarize" });
    expect(withTheOldFile).toMatchObject({ bound: true, verdict: "compliant" });
    expect(chain.writes).toEqual(["setComplianceProof(7)"]);
  });

  it("binds the mandate's refusal when asked to, without a preview, and says what it refused for", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ net: 2_000_000n }));
    const outcome = await bindComplianceProof({ client: chain.client, policy, prover: chain.prover, jobId: 7n, category: "text.summarize", bindRefusal: true });
    expect(outcome).toMatchObject({ bound: true, verdict: "refusal", violated: ["per_transaction_limit"] });
    expect(chain.writes).toEqual(["setComplianceProof(7)"]);
    expect(chain.judge(7n, chain.jobs.get("7")!.proof)).toBe(false);
  });

  it("tells a refusal the day or the hours can clear from one that stands", () => {
    const facts = { amount: 985_000n };
    expect(refusalIsTransient(["daily_limit"], facts, policy)).toBe(true);
    expect(refusalIsTransient(["time_window"], facts, policy)).toBe(true);
    expect(refusalIsTransient(["daily_limit", "time_window"], facts, policy)).toBe(true);
    // A single payment above the day's ceiling never fits.
    expect(refusalIsTransient(["daily_limit"], { amount: 6_000_000n }, policy)).toBe(false);
    expect(refusalIsTransient(["endpoint_category"], facts, policy)).toBe(false);
    expect(refusalIsTransient(["daily_limit", "blocked_recipient"], facts, policy)).toBe(false);
    expect(refusalIsTransient(null, facts, policy)).toBe(false);
    expect(refusalIsTransient([], facts, policy)).toBe(false);
  });
});

describe("ComplianceDuty", () => {
  const duty = (chain: ReturnType<typeof fakeChain>, events: DutyEvent[] = [], extra: Partial<ConstructorParameters<typeof ComplianceDuty>[0]> = {}) =>
    new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, onEvent: (e) => events.push(e), ...extra });
  // A Submitted job whose window closes in `left` seconds.
  const inWindow = (chain: ReturnType<typeof fakeChain>, left: bigint) => fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now + left });

  it("sends nothing for a Funded job, nor for a window with more than half the tolerance to run (square#349)", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    chain.jobs.set("8", inWindow(chain, 86_400n));
    const d = duty(chain);
    d.track(7n, "text.summarize");
    d.track(8n, "text.summarize");
    for (let i = 0; i < 3; i += 1) expect(await d.tick()).toMatchObject({ waiting: [7n, 8n], bound: [], current: [], released: [] });
    expect(chain.writes).toEqual([]);
    expect(chain.proofs).toEqual([]);
  });

  it("binds once the close is within half the tolerance, leaves it while current, and rebinds when the release moves", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", inWindow(chain, 1_801n));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    expect(await d.tick()).toMatchObject({ waiting: [7n], bound: [] });
    chain.now += 1n; // 1 800 s to the close: a proof bound now is still inside the tolerance at it
    expect(await d.tick()).toMatchObject({ bound: [7n], current: [], released: [] });
    expect(await d.tick()).toMatchObject({ bound: [], current: [7n] });
    chain.spent = 3n; // another release of the day moved the counter
    expect(await d.tick()).toMatchObject({ bound: [7n] });
    expect(events.filter((e) => e.type === "bound").map((e) => (e.type === "bound" ? e.because : []))).toEqual([["no proof is bound"], ["the day's counter is 3, the proof names 0"]]);
  });

  it("rebinds when the proof ages past half the module's tolerance, and reads the tolerance every tick", async () => {
    const chain = fakeChain({ commitment: commitment.hex, tolerance: 600n });
    chain.jobs.set("7", inWindow(chain, 0n));
    const d = duty(chain, [], { finalize: false });
    d.track(7n, "text.summarize");
    await d.tick();
    chain.now += 299n;
    expect(await d.tick()).toMatchObject({ current: [7n] });
    chain.now += 2n;
    expect(await d.tick()).toMatchObject({ bound: [7n] });
    // The owner halves the tolerance: the next tick binds to the new half.
    chain.tolerance = 300n;
    chain.now += 151n;
    expect(await d.tick()).toMatchObject({ bound: [7n] });
  });

  it("releases the job itself once the window closes, and the module verifies the proof it bound", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", inWindow(chain, 50n));
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

  it("releases two jobs of one day in sequence, rebinding the second after the first moved the counter", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", inWindow(chain, 0n));
    chain.jobs.set("8", inWindow(chain, 0n));
    const d = duty(chain);
    d.track(7n, "text.summarize");
    d.track(8n, "text.summarize");
    expect(await d.tick()).toMatchObject({ bound: [7n, 8n], released: [7n, 8n] });
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7)", "setComplianceProof(8)", "finalize(8)"]);
    expect(chain.proofs.map((p) => p.daily_spent_before)).toEqual(["0", "985000"]);
    expect(chain.spent).toBe(1_970_000n);
  });

  it("rebinds for the buyer of a sold receivable before releasing to it", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", inWindow(chain, 50n));
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

  it("waits on an open dispute without binding, and stops tracking a job another hand settled", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now - 1n, disputed: true }));
    chain.jobs.set("8", fundedJob({ status: JobStatus.Completed }));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    d.track(8n, "text.summarize");
    expect(await d.tick()).toMatchObject({ waiting: [7n], bound: [], released: [], settled: [8n] });
    expect(chain.writes).toEqual([]);
    expect(d.jobs().map((j) => j.jobId)).toEqual([7n]);
    expect(events.find((e) => e.type === "settled")).toMatchObject({ jobId: 8n, status: JobStatus.Completed });
  });

  // square#396. Since square#382 a job with no proof does not settle, so a
  // refusal the mandate will give tomorrow too is bound, and the release
  // refuses it: the net comes back to this wallet and the job is done.
  it("binds a refusal on a rule that stands, and the release refuses it back to this wallet", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", { ...inWindow(chain, 0n), net: 2_000_000n });
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    const report = await d.tick();
    expect(report.refused).toEqual([{ jobId: 7n, reason: "not-compliant: not compliant: per_transaction_limit" }]);
    expect(report.refusalBound).toEqual([7n]);
    expect(report.released).toEqual([7n]);
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7) refused"]);
    expect(events.map((e) => e.type)).toEqual(["refused", "refusal-bound", "released"]);
    expect(events.find((e) => e.type === "refusal-bound")).toMatchObject({ violated: ["per_transaction_limit"] });
    expect(events.find((e) => e.type === "released")).toMatchObject({ verified: null });
    expect(d.jobs()).toHaveLength(0);
  });

  it("waits out a refusal the day's counter can clear, reporting it once, and binds and pays when it does", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.spent = 4_500_000n; // 4.5 of the day's 5 USDC spent; this 0.985 does not fit today
    chain.jobs.set("7", inWindow(chain, 0n));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    const first = await d.tick();
    expect(first.refused).toEqual([{ jobId: 7n, reason: "not-compliant: not compliant: daily_limit" }]);
    expect(first.refusalBound).toEqual([]);
    expect(chain.writes).toEqual([]);
    await d.tick();
    expect(events.filter((e) => e.type === "refused")).toHaveLength(1);
    expect(d.jobs()).toHaveLength(1);
    // The day rolled over.
    chain.spent = 0n;
    const later = await d.tick();
    expect(later.bound).toEqual([7n]);
    expect(later.released).toEqual([7n]);
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7)"]);
    expect(d.jobs()).toHaveLength(0);
  });

  it("binds a refusal it was waiting out once the job is about to expire", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.spent = 4_500_000n;
    chain.jobs.set("7", { ...inWindow(chain, 0n), expiredAt: chain.now + 600n });
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    d.track(7n, "text.summarize");
    const report = await d.tick();
    expect(report.refusalBound).toEqual([7n]);
    expect(report.released).toEqual([7n]);
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7) refused"]);
  });

  it("names the pin for a job funded under the policy the client has since replaced, and binds nothing", async () => {
    const chain = fakeChain({ commitment: rotatedCommitment.hex });
    chain.jobs.set("7", { ...inWindow(chain, 0n), pinned: commitment.hex });
    const events: DutyEvent[] = [];
    const d = duty(chain, events, { policy: rotated });
    d.track(7n, "text.summarize");
    const report = await d.tick();
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toMatch(/^policy-pinned: /);
    expect(chain.writes).toEqual([]);
    expect(events.filter((e) => e.type === "refused")).toMatchObject([{ reason: "policy-pinned" }]);
    // The duty run with the older file proves and releases it.
    const older = duty(chain, [], { policy });
    older.track(7n, "text.summarize");
    const done = await older.tick();
    expect(done.released).toEqual([7n]);
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7)"]);
  });

  it("does nothing on a stack without a module, and says so once", async () => {
    const chain = fakeChain({ commitment: commitment.hex, module: null });
    chain.jobs.set("7", inWindow(chain, 0n));
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
    chain.jobs.set("7", inWindow(chain, -1n));
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

  describe("on a hook that screens (square#369)", () => {
    // A closed window with a current proof: the only thing between the duty and a finalize is the payee's screening.
    const closed = (screening: `0x${string}` | null = REGISTRY) => {
      const chain = fakeChain({ commitment: commitment.hex, screening });
      chain.jobs.set("7", { ...inWindow(chain, 0n), proof: proofWith({ commitment: commitment.hex, recipient: PROVIDER, amount: 985_000n, spent: 0n, timestamp: chain.now }) });
      return chain;
    };

    it("releases a cleared payee as before", async () => {
      const chain = closed();
      chain.screenings.set(PROVIDER.toLowerCase(), { screenedAt: chain.now - 10n, sanctioned: false });
      const events: DutyEvent[] = [];
      const d = duty(chain, events);
      d.track(7n, "text.summarize");
      expect(await d.tick()).toMatchObject({ current: [7n], released: [7n], held: [] });
      expect(chain.writes).toEqual(["finalize(7)"]);
      expect(events.at(-1)).toMatchObject({ type: "released", jobId: 7n, payee: PROVIDER, payeeCleared: true });
    });

    it("holds a payee with no fresh record instead of cranking it into the refusal, and says so once", async () => {
      const chain = closed();
      chain.screenings.set(PROVIDER.toLowerCase(), { screenedAt: chain.now - 3_601n, sanctioned: false });
      const events: DutyEvent[] = [];
      const d = duty(chain, events);
      d.track(7n, "text.summarize");
      const reason = `the registry holds no fresh, clean record for the payee ${PROVIDER} and no screener is configured to ask; the hook would refuse the release`;
      expect(await d.tick()).toMatchObject({ current: [7n], released: [], held: [{ jobId: 7n, payee: PROVIDER, reason }] });
      expect(await d.tick()).toMatchObject({ released: [], held: [{ jobId: 7n, payee: PROVIDER, reason }] });
      expect(chain.writes).toEqual([]);
      expect(events.filter((e) => e.type === "held")).toEqual([{ type: "held", jobId: 7n, payee: PROVIDER, reason }]);
      expect(d.jobs()).toHaveLength(1);
      // A screening lands: the next tick releases, and the payee is paid.
      chain.screenings.set(PROVIDER.toLowerCase(), { screenedAt: chain.now, sanctioned: false });
      expect(await d.tick()).toMatchObject({ released: [7n], held: [] });
      expect(chain.writes).toEqual(["finalize(7)"]);
      expect(chain.spent).toBe(985_000n);
    });

    it("asks its screener for the missing record and releases in the same tick", async () => {
      const chain = closed();
      const asked: string[][] = [];
      const d = duty(chain, [], {
        screener: {
          async screen(subjects) {
            asked.push([...subjects]);
            for (const subject of subjects) chain.screenings.set(subject.toLowerCase(), { screenedAt: chain.now, sanctioned: false });
          },
        },
      });
      d.track(7n, "text.summarize");
      expect(await d.tick()).toMatchObject({ released: [7n], held: [] });
      expect(asked).toEqual([[PROVIDER]]);
      expect(chain.writes).toEqual(["finalize(7)"]);
    });

    it("holds when the screener was asked and the registry still clears nobody", async () => {
      const chain = closed();
      const d = duty(chain, [], { screener: { async screen() {} } });
      d.track(7n, "text.summarize");
      const report = await d.tick();
      expect(report.released).toEqual([]);
      expect(report.held).toMatchObject([{ jobId: 7n, reason: expect.stringContaining("the screener was asked and the registry still holds no fresh, clean record") }]);
      expect(chain.writes).toEqual([]);
    });

    it("releases a payee a fresh record says is designated: the refusal is the outcome screening exists for", async () => {
      const chain = closed();
      chain.screenings.set(PROVIDER.toLowerCase(), { screenedAt: chain.now - 10n, sanctioned: true });
      const events: DutyEvent[] = [];
      const asked: string[][] = [];
      const d = duty(chain, events, { screener: { async screen(subjects) { asked.push([...subjects]); } } });
      d.track(7n, "text.summarize");
      expect(await d.tick()).toMatchObject({ released: [7n], held: [] });
      expect(asked).toEqual([]);
      expect(chain.writes).toEqual(["finalize(7) refused"]);
      expect(chain.spent).toBe(0n);
      expect(events.at(-1)).toMatchObject({ type: "released", jobId: 7n, payeeCleared: false });
    });

    it("reads nobody's record on a hook that holds no registry", async () => {
      const chain = closed(null);
      const d = duty(chain, [], { screener: { async screen() { throw new Error("must not be asked"); } } });
      d.track(7n, "text.summarize");
      expect(await d.tick()).toMatchObject({ released: [7n], held: [] });
    });
  });

  it("runs on a cadence until aborted, recovering first", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", inWindow(chain, 0n));
    const events: DutyEvent[] = [];
    const d = duty(chain, events);
    const controller = new AbortController();
    const done = d.run(controller.signal, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await done;
    // Nothing was tracked by hand: the chain scan found job 7 and the run released it.
    expect(events[0]).toEqual({ type: "recovered", restored: [], discovered: [7n] });
    expect(chain.writes).toEqual(["setComplianceProof(7)", "finalize(7)"]);
  });
});

describe("ComplianceDuty across a restart (square#348)", () => {
  const memoryState = (initial: TrackedJob[] = []) => {
    const store = { jobs: initial, saves: 0 };
    const state: DutyState = {
      load: () => store.jobs.map((j) => ({ ...j })),
      save: (jobs) => {
        store.jobs = jobs.map((j) => ({ ...j }));
        store.saves += 1;
      },
    };
    return { store, state };
  };

  it("writes every change of the tracked set to the state, and reads it back", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    const { store, state } = memoryState();
    const first = new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, state, discover: false });
    first.track(7n, "text.summarize", 1_000_000n);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.jobs).toEqual([{ jobId: 7n, category: "text.summarize", budget: 1_000_000n }]);

    const events: DutyEvent[] = [];
    const second = new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, state, discover: false, onEvent: (e) => events.push(e) });
    expect(second.jobs()).toEqual([]);
    expect(await second.recover()).toEqual({ restored: [7n], discovered: [] });
    expect(second.jobs()).toEqual([{ jobId: 7n, category: "text.summarize", budget: 1_000_000n }]);
    expect(events).toEqual([{ type: "recovered", restored: [7n], discovered: [] }]);

    // Settling drops it from the state too.
    chain.jobs.get("7")!.status = JobStatus.Completed;
    await second.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.jobs).toEqual([]);
  });

  it("finds this wallet's open jobs on the chain when the state does not hold them, and skips the settled and other wallets'", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    chain.jobs.set("7", fundedJob());
    chain.jobs.set("8", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now + 10n }));
    chain.jobs.set("9", fundedJob({ status: JobStatus.Completed }));
    chain.jobs.set("10", fundedJob({ client: BUYER }));
    const { store, state } = memoryState([{ jobId: 7n, category: "text.summarize" }]);
    const d = new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, state, discoverBatchBlocks: 40n });
    expect(await d.recover()).toEqual({ restored: [7n], discovered: [8n] });
    expect(d.jobs()).toEqual([
      { jobId: 7n, category: "text.summarize" },
      { jobId: 8n, category: undefined },
    ]);
    // The scan walked the chain from block 0 to the head in spans of 40.
    expect(chain.scans).toEqual([[0n, 39n], [40n, 79n], [80n, 100n]]);
    expect(store.jobs.map((j) => j.jobId)).toEqual([7n, 8n]);
  });

  it("halves the span when the endpoint refuses it", async () => {
    const chain = fakeChain({ commitment: commitment.hex });
    const getLogs = chain.client.publicClient.getLogs;
    chain.client.publicClient.getLogs = (async (params: { fromBlock: bigint; toBlock: bigint }) => {
      if (params.toBlock - params.fromBlock >= 30n) throw new Error("query returned more than 10000 results");
      return getLogs(params as never);
    }) as never;
    const d = new ComplianceDuty({ client: chain.client, policy, prover: chain.prover, discoverBatchBlocks: 64n });
    await d.recover();
    expect(chain.scans.every(([from, to]) => to - from < 30n)).toBe(true);
    expect(chain.scans[0]).toEqual([0n, 15n]);
  });

  it("learns a recovered job's category from its first proof, trying the policy's categories in order", async () => {
    const wide = parsePolicy({ ...policy, allowed_endpoint_categories: ["code.review", "text.summarize", "image.caption"] });
    const chain = fakeChain({ commitment: (await policyCommitment(wide)).hex });
    chain.jobs.set("8", fundedJob({ status: JobStatus.Submitted, challengeEnd: chain.now }));
    const { store, state } = memoryState();
    const d = new ComplianceDuty({ client: chain.client, policy: wide, prover: chain.prover, state });
    await d.recover();
    expect(d.jobs()).toEqual([{ jobId: 8n, category: undefined }]);
    // The fake prover refuses every category but the one the policy's list holds... which is all three;
    // so the first answers. Narrow the prover to accept only the second.
    const prove = chain.prover.prove.bind(chain.prover);
    chain.prover.prove = async (request) => {
      const response = await prove(request);
      if (request.payment_endpoint_category !== "text.summarize") return { ...response, is_compliant: false, violated_rules: ["endpoint_category"] };
      return response;
    };
    expect(await d.tick()).toMatchObject({ bound: [8n], released: [8n] });
    expect(chain.proofs.map((p) => p.payment_endpoint_category)).toEqual(["code.review", "text.summarize"]);
    expect(store.jobs).toEqual([]);
  });
});
