import { describe, expect, it } from "vitest";
import {
  decide,
  decideAll,
  gasCostInUsdc,
  keeperFee,
  minimumProfitableBudget,
  oldestPendingAge,
  type KeeperCandidate,
  type KeeperEconomics,
} from "../src/decide.js";

const gwei = 1_000_000_000n;
const economics: KeeperEconomics = {
  gasPriceWei: 20n * gwei,
  finalizeGas: 420_000n,
  finalizeDecidedGas: 470_000n,
  minimumMarginBps: 2_000,
};

function candidate(overrides: Partial<KeeperCandidate> = {}): KeeperCandidate {
  return {
    jobId: 1n,
    status: 2,
    disputed: false,
    challengeEnd: 1_000n,
    budget: 1_000_000_000n,
    evaluatorFeeBP: 50,
    ...overrides,
  };
}

describe("economics", () => {
  it("converts native gas cost to 6-decimal USDC", () => {
    expect(gasCostInUsdc(20n * gwei, 420_000n)).toBe(8_400n);
  });

  it("computes the keeper fee from the snapshotted basis points", () => {
    expect(keeperFee(1_000_000_000n, 50)).toBe(5_000_000n);
  });

  it("derives the smallest budget that pays the crank", () => {
    const floor = minimumProfitableBudget(50, 20n * gwei, 420_000n);
    expect(floor).toBe(1_680_000n);
    expect(keeperFee(floor, 50)).toBeGreaterThanOrEqual(8_400n);
    expect(keeperFee(floor - 1n, 50)).toBeLessThan(8_400n);
    expect(minimumProfitableBudget(0, 20n * gwei, 420_000n)).toBe(-1n);
  });
});

describe("decide", () => {
  it("finalizes a closed, undisputed, profitable job", () => {
    expect(decide(candidate(), 1_000n, economics)).toEqual({ kind: "finalize", jobId: 1n, fee: 5_000_000n, gasCost: 8_400n });
  });

  it("waits while the window is open", () => {
    expect(decide(candidate(), 999n, economics)).toEqual({ kind: "skip", jobId: 1n, reason: "windowOpen" });
    expect(decide(candidate({ challengeEnd: null }), 5_000n, economics)).toEqual({ kind: "skip", jobId: 1n, reason: "windowOpen" });
  });

  it("skips a job that would lose money, including the margin", () => {
    expect(decide(candidate({ budget: 1_000_000n }), 1_000n, economics)).toEqual({ kind: "skip", jobId: 1n, reason: "unprofitable" });
    expect(decide(candidate({ budget: 2_015_999n }), 1_000n, economics).kind).toBe("skip");
    expect(decide(candidate({ budget: 2_016_000n }), 1_000n, economics).kind).toBe("finalize");
  });

  it("never touches a job that is not submitted", () => {
    expect(decide(candidate({ status: 1 }), 1_000n, economics).kind).toBe("skip");
    expect(decide(candidate({ status: 3 }), 1_000n, economics).kind).toBe("skip");
  });

  it("handles disputes: waits for a decision, applies a completion, leaves a rejection alone", () => {
    expect(decide(candidate({ disputed: true }), 1_000n, economics)).toEqual({ kind: "skip", jobId: 1n, reason: "awaitingDecision" });
    expect(decide(candidate({ disputed: true, decidedOutcome: 1 }), 1_000n, economics)).toEqual({
      kind: "finalizeDecided",
      jobId: 1n,
      fee: 5_000_000n,
      gasCost: 9_400n,
    });
    expect(decide(candidate({ disputed: true, decidedOutcome: 3 }), 1_000n, economics).kind).toBe("finalizeDecided");
    expect(decide(candidate({ disputed: true, decidedOutcome: 2 }), 1_000n, economics)).toEqual({ kind: "skip", jobId: 1n, reason: "disputed" });
    expect(decide(candidate({ disputed: true, decidedOutcome: 1, disputeClosed: true }), 1_000n, economics).kind).toBe("skip");
  });

  it("reports the oldest pending age, the signal that the keeper stopped", () => {
    const list = [candidate({ jobId: 1n, challengeEnd: 100n }), candidate({ jobId: 2n, challengeEnd: 900n }), candidate({ jobId: 3n, challengeEnd: 5_000n })];
    expect(oldestPendingAge(list, 1_000n)).toBe(900n);
    expect(oldestPendingAge(list, 50n)).toBe(0n);
    expect(decideAll(list, 1_000n, economics).map((a) => a.kind)).toEqual(["finalize", "finalize", "skip"]);
  });
});
