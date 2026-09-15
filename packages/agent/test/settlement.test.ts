import { describe, expect, it } from "vitest";
import { hashDeliverable, JobStatus, type SquareClient } from "@squaresdk/core";
import type { Hex } from "viem";
import { squareSettlement } from "../src/settlement.js";

/**
 * The three answers the settlement gives, against a SquareClient stub that
 * records what was asked of it. The chain itself is test/anvil.test.ts.
 */
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const TX = ("0x" + "11".repeat(32)) as Hex;
const NOW = 1_800_000_000n;

type Record_ = { status: number; client: `0x${string}`; provider: `0x${string}`; budget: bigint; expiredAt: number; settlementHorizon: number };
const CLIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

function stub(records: Record<string, Record_>, submitEvents: (jobId: bigint, deliverable: Hex) => unknown[] = () => [], chainNow = NOW, gate: { module?: boolean; policy?: boolean } = {}) {
  const submits: unknown[] = [];
  const client = {
    account: AGENT,
    async complianceModule() {
      return gate.module ? "0x000000000000000000000000000000000000c0de" : null;
    },
    async policyOf() {
      return { commitment: gate.policy ? `0x${"ab".repeat(32)}` : `0x${"0".repeat(64)}`, dailyLimit: 0n, updatedAt: 0n, epoch: 0n };
    },
    publicClient: {
      async getBlock() {
        return { timestamp: chainNow };
      },
    },
    async getJobRecord(jobId: bigint) {
      const record = records[jobId.toString()];
      if (!record) throw new Error(`InvalidJob() for ${jobId}`);
      return record;
    },
    async submit(params: { jobId: bigint; deliverable: Hex; agentId?: bigint }) {
      submits.push(params);
      return { hash: TX, receipt: {}, events: submitEvents(params.jobId, params.deliverable) };
    },
  } as unknown as SquareClient;
  return { client, submits };
}

// A day's settlement horizon; the kernel floors anything shorter at 15 minutes.
const HORIZON = 86_400;
const funded = (overrides: Partial<Record_> = {}): Record_ => ({ status: JobStatus.Funded, client: CLIENT, provider: AGENT, budget: 5_000_000n, expiredAt: 1_900_000_000, settlementHorizon: HORIZON, ...overrides });
const submitted = (jobId: bigint, deliverable: Hex) => [{ contract: "SquareJob", eventName: "JobSubmitted", args: { jobId, provider: AGENT, deliverable } }];
const task = { capability: "text.summarize", callerDid: "did:aip:eip155:31337:0x0000000000000000000000000000000000000001:9" };

describe("admit", () => {
  it("takes a job the chain shows Funded for this wallet, in date, at or above the capability's price", async () => {
    const { client } = stub({ "42": funded() });
    const settlement = squareSettlement({ client, agentId: 1n, now: () => NOW, minimumBudgetFor: () => 5_000_000n });
    expect(await settlement.admit("42", task)).toEqual({ ok: true });
  });

  it.each([
    ["not a job id", { "42": funded() }, "abc", /not a job id/],
    ["a job the chain does not know", {}, "7", /could not be read/],
    ["an Open job", { "42": funded({ status: JobStatus.Open }) }, "42", /is Open, not Funded/],
    ["a Submitted job", { "42": funded({ status: JobStatus.Submitted }) }, "42", /is Submitted, not Funded/],
    ["a job funded for another provider", { "42": funded({ provider: OTHER }) }, "42", new RegExp(`funded for provider ${OTHER}`)],
    ["an expired job", { "42": funded({ expiredAt: Number(NOW) }) }, "42", /expired at/],
    [
      "a job with less than its settlement horizon left, which submit would refuse",
      { "42": funded({ expiredAt: Number(NOW) + HORIZON - 1 }) },
      "42",
      new RegExp(`cannot be submitted: it expires at ${Number(NOW) + HORIZON - 1}, ${HORIZON - 1}s from now, and submit needs ${HORIZON}s before expiry \\(settlement horizon ${HORIZON}s, floor 900s\\)`),
    ],
    [
      "a job under the kernel's 15 minute floor, whatever its horizon",
      { "42": funded({ expiredAt: Number(NOW) + 899, settlementHorizon: 0 }) },
      "42",
      /cannot be submitted: .* submit needs 900s before expiry \(settlement horizon 0s, floor 900s\)/,
    ],
    ["a job funded below the price", { "42": funded({ budget: 4_999_999n }) }, "42", /funded with 4999999 but text.summarize costs 5000000/],
  ])("refuses %s, with the reason", async (_label, records, jobId, reason) => {
    const { client } = stub(records as Record<string, Record_>);
    const settlement = squareSettlement({ client, agentId: 1n, now: () => NOW, minimumBudgetFor: () => 5_000_000n });
    const verdict = await settlement.admit(jobId, task);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });

  it("takes a job with exactly its settlement window left, the last second submit accepts", async () => {
    const { client } = stub({ "42": funded({ expiredAt: Number(NOW) + HORIZON }), "43": funded({ expiredAt: Number(NOW) + 900, settlementHorizon: 0 }) });
    const settlement = squareSettlement({ client, agentId: 1n, now: () => NOW });
    expect(await settlement.admit("42", task)).toEqual({ ok: true });
    expect(await settlement.admit("43", task)).toEqual({ ok: true });
  });

  it("measures the window against the chain's clock, the latest block, unless told otherwise", async () => {
    // The wall clock is nowhere near this job's expiry; the chain's is past it.
    const { client } = stub({ "42": funded({ expiredAt: 1_900_000_000 }) }, () => [], 1_900_000_000n);
    const settlement = squareSettlement({ client, agentId: 1n });
    const verdict = await settlement.admit("42", task);
    expect(verdict).toEqual({ ok: false, reason: "job 42 expired at 1900000000" });
  });

  it("refuses, rather than throws, when the chain's clock cannot be read", async () => {
    const { client } = stub({ "42": funded() });
    const settlement = squareSettlement({ client, agentId: 1n, now: () => Promise.reject(new Error("HTTP request failed")) });
    expect(await settlement.admit("42", task)).toEqual({ ok: false, reason: "the chain's clock could not be read for job 42: HTTP request failed" });
  });

  it("refuses a job whose client has no policy on a hook with a compliance module, and takes it once the client commits (square#350)", async () => {
    const gated = stub({ "42": funded() }, () => [], NOW, { module: true });
    expect(await squareSettlement({ client: gated.client, agentId: 1n, now: () => NOW }).admit("42", task)).toEqual({
      ok: false,
      reason: `job 42 cannot pay: the hook holds a compliance module and its client ${CLIENT} has no policy on the registry, so the release would be refused; the client has to commit a policy first`,
    });
    const committed = stub({ "42": funded() }, () => [], NOW, { module: true, policy: true });
    expect(await squareSettlement({ client: committed.client, agentId: 1n, now: () => NOW }).admit("42", task)).toEqual({ ok: true });
    const open = stub({ "42": funded() });
    expect(await squareSettlement({ client: open.client, agentId: 1n, now: () => NOW }).admit("42", task)).toEqual({ ok: true });
  });

  it("takes any funded amount when the capability carries no price", async () => {
    const { client } = stub({ "42": funded({ budget: 1n }) });
    const settlement = squareSettlement({ client, agentId: 1n, now: () => NOW });
    expect(await settlement.admit("42", task)).toEqual({ ok: true });
  });
});

describe("deliver", () => {
  it("submits the hash of the content, bound to the agent, and carries the hash and the transaction", async () => {
    const { client, submits } = stub({}, submitted);
    const settlement = squareSettlement({ client, agentId: 892271n });
    const delivery = await settlement.deliver("42", "the brief, in full", { taskId: "t1", capability: "text.summarize" });
    const deliverable = hashDeliverable("the brief, in full");
    expect(delivery).toEqual({ deliverable, reference: TX });
    expect(submits).toEqual([{ jobId: 42n, deliverable, agentId: 892271n }]);
  });

  it("does not report DELIVERED for a transaction that mined without a JobSubmitted for this job", async () => {
    const { client } = stub({}, (jobId, deliverable) => submitted(jobId + 1n, deliverable));
    const settlement = squareSettlement({ client, agentId: 1n });
    await expect(settlement.deliver("42", "x", { taskId: "t1", capability: "c" })).rejects.toThrow(/without a JobSubmitted event/);
  });

  it("lets the chain's refusal through as the failure reason", async () => {
    const client = {
      account: AGENT,
      async submit() {
        throw new Error("PastExpiry()");
      },
    } as unknown as SquareClient;
    const settlement = squareSettlement({ client, agentId: 1n });
    await expect(settlement.deliver("42", "x", { taskId: "t1", capability: "c" })).rejects.toThrow("PastExpiry()");
  });
});

describe("jobStatus", () => {
  it("is the record's status, read each time", async () => {
    let status: number = JobStatus.Submitted;
    const client = { account: AGENT, async getJobRecord() { return funded({ status }); } } as unknown as SquareClient;
    const settlement = squareSettlement({ client, agentId: 1n });
    expect(await settlement.jobStatus?.("42")).toBe(JobStatus.Submitted);
    status = JobStatus.Completed;
    expect(await settlement.jobStatus?.("42")).toBe(JobStatus.Completed);
  });
});
