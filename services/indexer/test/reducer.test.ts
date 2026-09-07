import { describe, expect, it } from "vitest";
import type { SquareEvent } from "@squaresdk/core";
import {
  applyEvent,
  emptyState,
  finalizableJobs,
  jobsInChallengeWindow,
  jobsOfProvider,
  ledgerKey,
  openJobs,
  payeeOf,
  reduce,
  windowFor,
} from "../src/reducer.js";

const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const provider = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const buyer = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const evaluator = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" as const;
const hook = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;

let index = 0;
function ev(contract: SquareEvent["contract"], eventName: string, args: Record<string, unknown>, block = 1n): SquareEvent {
  index += 1;
  return {
    contract,
    eventName,
    args,
    blockNumber: block,
    logIndex: index,
    address: zero,
    transactionHash: "0x" + "00".repeat(32),
    data: "0x",
    topics: [],
    blockHash: "0x" + "00".repeat(32),
    transactionIndex: 0,
    removed: false,
  } as unknown as SquareEvent;
}

function lifecycle(): SquareEvent[] {
  return [
    ev("KeeperEvaluator", "WindowsConfigured", { effectiveFrom: 0, challengeWindow: 86_400, disputeWindow: 259_200 }),
    ev("SquareJob", "JobCreated", { jobId: 1n, client, provider, evaluator, expiredAt: 5_000_000n, hook }),
    ev("SquareJob", "JobDescribed", { jobId: 1n, createdAt: 1_000_000, description: "spec:0xabc" }),
    ev("SquareJob", "BudgetSet", { jobId: 1n, amount: 100_000_000n }),
    ev("SquareJob", "JobFunded", { jobId: 1n, client, amount: 100_000_000n }),
    ev("SquareJob", "FeesSnapshotted", { jobId: 1n, platformFeeBP: 100, evaluatorFeeBP: 50, fundedAt: 1_000_100 }),
    ev("SquareJob", "JobSubmitted", { jobId: 1n, provider, deliverable: "0x" + "11".repeat(32) }),
    ev("SquareJob", "SubmissionTimed", { jobId: 1n, submittedAt: 1_000_200, expiredAt: 5_000_000 }),
    ev("SquareHook", "AgentBound", { jobId: 1n, agentId: 892_271n, validationRequestHash: "0x" + "00".repeat(32) }),
  ];
}

describe("reducer", () => {
  it("rebuilds a submitted job with its challenge end from events alone", () => {
    const state = reduce(lifecycle());
    const job = state.jobs.get(1n);
    expect(job?.status).toBe(2);
    expect(job?.budget).toBe(100_000_000n);
    expect(job?.platformFeeBP).toBe(100);
    expect(job?.evaluatorFeeBP).toBe(50);
    expect(job?.submittedAt).toBe(1_000_200n);
    expect(job?.challengeEnd).toBe(1_000_200n + 86_400n);
    expect(job?.agentId).toBe(892_271n);
    expect(job?.description).toBe("spec:0xabc");
    expect(jobsInChallengeWindow(state, 1_000_300n).map((j) => j.jobId)).toEqual([1n]);
    expect(finalizableJobs(state, 1_000_300n)).toEqual([]);
    expect(finalizableJobs(state, 1_000_200n + 86_400n).map((j) => j.jobId)).toEqual([1n]);
    expect(jobsOfProvider(state, provider).length).toBe(1);
    expect(openJobs(state)).toEqual([]);
  });

  it("uses the window in force at submission, not the latest one", () => {
    const events = lifecycle();
    events.splice(1, 0, ev("KeeperEvaluator", "WindowsConfigured", { effectiveFrom: 2_000_000, challengeWindow: 60, disputeWindow: 60 }));
    const state = reduce(events);
    expect(windowFor(state.windows, 1_000_200n)?.challengeWindow).toBe(86_400n);
    expect(windowFor(state.windows, 2_000_001n)?.challengeWindow).toBe(60n);
    expect(state.jobs.get(1n)?.challengeEnd).toBe(1_000_200n + 86_400n);
  });

  it("tracks the ledger through release, split, fees and withdrawals", () => {
    const state = reduce([
      ...lifecycle(),
      ev("SquareJob", "PlatformFeeAccrued", { jobId: 1n, treasury: evaluator, amount: 1_000_000n }),
      ev("SquareJob", "EvaluatorFeePaid", { jobId: 1n, evaluator, amount: 500_000n }),
      ev("SquareJob", "PaymentReleased", { jobId: 1n, provider: buyer, amount: 49_250_000n }),
      ev("SquareJob", "Refunded", { jobId: 1n, client, amount: 49_250_000n }),
      ev("SquareJob", "PayoutRouted", { jobId: 1n, payee: buyer, providerBps: 5_000, providerShare: 49_250_000n, clientShare: 49_250_000n }),
      ev("SquareJob", "JobCompleted", { jobId: 1n, evaluator, reason: "0x" + "22".repeat(32) }),
      ev("SquareJob", "Withdrawn", { account: buyer, to: buyer, amount: 49_250_000n }),
    ]);
    expect(state.ledger.get(ledgerKey("SquareJob", buyer))).toBe(0n);
    expect(state.ledger.get(ledgerKey("SquareJob", client))).toBe(49_250_000n);
    expect(state.ledger.get(ledgerKey("SquareJob", evaluator))).toBe(1_500_000n);
    const job = state.jobs.get(1n);
    expect(job?.status).toBe(3);
    expect(job?.payee).toBe(buyer);
    expect(job?.providerBps).toBe(5_000);
    expect(job?.reason).toBe("0x" + "22".repeat(32));
  });

  it("tracks disputes, votes, decisions and bond settlement", () => {
    const hash = ("0x" + "33".repeat(32)) as `0x${string}`;
    const state = reduce([
      ...lifecycle(),
      ev("Arbitration", "ArbitersUpdated", { version: 1, arbiters: [buyer, client, provider], threshold: 2 }),
      ev("KeeperEvaluator", "DisputeRaised", { jobId: 1n, disputer: client, disputedAt: 1_000_300, challengeEnd: 1_086_600 }),
      ev("Arbitration", "DisputeOpened", { jobId: 1n, disputer: client, bond: 10_000_000n, disputedAt: 1_000_300, setVersion: 1, resolveBy: 1_259_500 }),
      ev("Arbitration", "VoteCast", { jobId: 1n, arbiter: buyer, resolutionHash: hash, outcome: 2, providerBps: 0, approvals: 1n }),
      ev("Arbitration", "VoteCast", { jobId: 1n, arbiter: client, resolutionHash: hash, outcome: 2, providerBps: 0, approvals: 3n }),
      ev("Arbitration", "DecisionReached", { jobId: 1n, outcome: 2, providerBps: 0, resolutionHash: hash }),
      ev("KeeperEvaluator", "DecisionApplied", { jobId: 1n, outcome: 2, providerBps: 0, keeper: buyer, keeperFee: 0n }),
      ev("SquareJob", "Refunded", { jobId: 1n, client, amount: 100_000_000n }),
      ev("SquareJob", "JobRejected", { jobId: 1n, rejector: evaluator, reason: hash }),
      ev("Arbitration", "BondSettled", { jobId: 1n, to: client, amount: 10_000_000n }),
    ]);
    const dispute = state.disputes.get(1n);
    expect(dispute?.approvals.get(hash)).toBe(3n);
    expect(dispute?.outcome).toBe(2);
    expect(dispute?.closed).toBe(true);
    expect(state.jobs.get(1n)?.status).toBe(4);
    expect(state.jobs.get(1n)?.disputed).toBe(false);
    expect(state.ledger.get(ledgerKey("Arbitration", client))).toBe(10_000_000n);
    expect(state.arbiterSets.get(1)?.threshold).toBe(2);
    expect(jobsInChallengeWindow(state, 1_000_400n)).toEqual([]);
  });

  it("routes the payee to the buyer once a claim is sold and back on cancel", () => {
    const state = reduce([...lifecycle(), ev("ClaimMarket", "ClaimListed", { jobId: 1n, seller: provider, price: 90_000_000n, faceValue: 98_500_000n })]);
    expect(payeeOf(state, 1n)).toBe(provider);
    applyEvent(state, ev("ClaimMarket", "ClaimBought", { jobId: 1n, buyer, seller: provider, price: 90_000_000n }));
    expect(payeeOf(state, 1n)).toBe(buyer);
    expect(state.listings.get(1n)?.status).toBe(2);
    const other = reduce([...lifecycle(), ev("ClaimMarket", "ClaimListed", { jobId: 1n, seller: provider, price: 1n, faceValue: 2n }), ev("ClaimMarket", "ClaimCancelled", { jobId: 1n, seller: provider })]);
    expect(payeeOf(other, 1n)).toBe(provider);
  });

  it("refuses an event for a job it has never seen", () => {
    expect(() => reduce([ev("SquareJob", "BudgetSet", { jobId: 9n, amount: 1n })])).toThrow(/unknown job 9/);
  });

  it("starts empty", () => {
    const state = emptyState();
    expect(state.jobs.size).toBe(0);
    expect(finalizableJobs(state, 0n)).toEqual([]);
  });
});
