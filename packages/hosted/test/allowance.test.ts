import { describe, expect, it } from "vitest";
import { JobStatus } from "@squaresdk/core";
import { parseUnits } from "viem";
import { PolicyAllowance } from "../src/allowance.js";
import { fakeSquare, HOST_WALLET, SUB_WALLET } from "./helpers/fakeSquare.js";

const usdc = (n: string) => parseUnits(n, 6);
const COMMITMENT = `0x${"00".repeat(31)}2a` as const;

describe("PolicyAllowance: the policy's ceiling, read from the chain, less what is in flight", () => {
  it("allows nothing without a policy, and fails closed on a zero commitment", async () => {
    const chain = fakeSquare();
    const allowance = new PolicyAllowance({ client: chain.client });
    expect(await allowance.view()).toEqual({ policy: false, dailyLimit: 0n, spentToday: 0n, inFlight: 0n, available: 0n });
    expect(await allowance.admit(1n)).toBe(`${HOST_WALLET} has no policy on the registry, so it may delegate nothing`);
  });

  it("counts what the wallet funded until the chain settles it, and what the registry released today", async () => {
    const chain = fakeSquare();
    await chain.client.setPolicy(COMMITMENT, usdc("0.50"));
    const allowance = new PolicyAllowance({ client: chain.client });
    expect(await allowance.admit(usdc("0.30"))).toBeUndefined();
    const { jobId } = await chain.client.createJob({ provider: SUB_WALLET, expiredAt: 4_000_000_000n });
    await chain.client.setBudget(jobId, usdc("0.30"));
    await chain.client.fund(jobId, usdc("0.30"));
    allowance.funded({ jobId, budget: usdc("0.30") });
    expect(await allowance.view()).toMatchObject({ policy: true, dailyLimit: usdc("0.50"), spentToday: 0n, inFlight: usdc("0.30"), available: usdc("0.20") });
    expect(await allowance.admit(usdc("0.25"))).toMatch(/^0.25 USDC is more than the policy allows today: ceiling 0.5, 0 released today, 0.3 in flight on 1 job\(s\), 0.2 available$/);
    expect(await allowance.admit(usdc("0.20"))).toBeUndefined();

    // The evaluator releases the job: it leaves flight and enters the registry's count, on the same ceiling.
    chain.records.get(jobId)!.status = JobStatus.Submitted;
    chain.release(jobId);
    expect(await allowance.view()).toMatchObject({ spentToday: usdc("0.30"), inFlight: 0n, available: usdc("0.20") });
    expect(allowance.inFlightJobs()).toEqual([]);
  });

  it("drops a refunded or expired job the same way, and caps one job below the ceiling when told to", async () => {
    const chain = fakeSquare();
    await chain.client.setPolicy(COMMITMENT, usdc("1.00"));
    const allowance = new PolicyAllowance({ client: chain.client, maxPerJob: usdc("0.25") });
    expect(await allowance.admit(usdc("0.26"))).toBe("0.26 USDC is more than one delegated job may be funded with (0.25)");
    const { jobId } = await chain.client.createJob({ provider: SUB_WALLET, expiredAt: 4_000_000_000n });
    await chain.client.setBudget(jobId, usdc("0.25"));
    await chain.client.fund(jobId, usdc("0.25"));
    allowance.funded({ jobId, budget: usdc("0.25") });
    expect((await allowance.view()).inFlight).toBe(usdc("0.25"));
    chain.records.get(jobId)!.status = JobStatus.Expired;
    expect((await allowance.view()).inFlight).toBe(0n);
  });

  it("takes the jobs a previous process funded back in, and reads them off the chain", async () => {
    const chain = fakeSquare();
    await chain.client.setPolicy(COMMITMENT, usdc("1.00"));
    const { jobId } = await chain.client.createJob({ provider: SUB_WALLET, expiredAt: 4_000_000_000n });
    await chain.client.setBudget(jobId, usdc("0.40"));
    await chain.client.fund(jobId, usdc("0.40"));
    const allowance = new PolicyAllowance({ client: chain.client });
    allowance.restore([{ jobId, budget: usdc("0.40") }]);
    expect((await allowance.view()).available).toBe(usdc("0.60"));
    expect(allowance.inFlightJobs()).toEqual([{ jobId, budget: usdc("0.40") }]);
  });
});
