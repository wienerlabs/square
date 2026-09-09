import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { classify, walletInbox, walletJobCount } from "./inbox";
import type { JobSummary } from "./square";

const me = "0x00000000000000000000000000000000000000Aa" as const;
const other = "0x00000000000000000000000000000000000000Bb" as const;
const keeper = "0x00000000000000000000000000000000000000Cc" as const;
const thirdParty = "0x00000000000000000000000000000000000000Dd" as const;

const job = (over: Partial<JobSummary>): JobSummary => ({
  id: 1n,
  client: me,
  provider: other,
  evaluator: keeper,
  budget: 1_000_000n,
  status: JobStatus.Open,
  createdAt: 1_000,
  fundedAt: 0,
  expiredAt: 10_000,
  submittedAt: 0,
  challengeEnd: 0,
  disputed: false,
  platformFeeBP: 100,
  evaluatorFeeBP: 50,
  providerBps: 0,
  ...over,
});

describe("classify", () => {
  const now = 2_000;

  it("asks the client for a budget, then for funding", () => {
    expect(classify(job({ budget: 0n }), me, keeper, now)).toBe("budget");
    expect(classify(job({}), me, keeper, now)).toBe("fund");
    expect(classify(job({ provider: "0x0000000000000000000000000000000000000000" }), me, keeper, now)).toBeNull();
  });

  it("asks the provider for the deliverable while funded and live", () => {
    expect(classify(job({ status: JobStatus.Funded, client: other, provider: me }), me, keeper, now)).toBe("submit");
    expect(classify(job({ status: JobStatus.Funded }), me, keeper, now)).toBeNull();
    expect(classify(job({ status: JobStatus.Funded, expiredAt: 1_500 }), me, keeper, now)).toBe("refund");
    expect(classify(job({ status: JobStatus.Submitted, expiredAt: 1_500, challengeEnd: 3_000 }), me, keeper, now)).toBeNull();
  });

  it("offers the refund on an expired submission the keeper does not evaluate, whatever the challenge window says", () => {
    expect(classify(job({ status: JobStatus.Submitted, evaluator: thirdParty, expiredAt: 1_500, challengeEnd: 3_000 }), me, keeper, now)).toBe("refund");
    expect(classify(job({ status: JobStatus.Submitted, evaluator: thirdParty, expiredAt: 1_500, challengeEnd: 1_800 }), me, keeper, now)).toBe("refund");
  });

  it("stays silent on a job a third party evaluates while it is still live", () => {
    expect(classify(job({ status: JobStatus.Submitted, evaluator: thirdParty, challengeEnd: 3_000 }), me, keeper, now)).toBeNull();
    expect(classify(job({ status: JobStatus.Submitted, evaluator: thirdParty, challengeEnd: 1_500 }), me, keeper, now)).toBeNull();
  });

  it("follows the challenge window for a submitted job", () => {
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 3_000 }), me, keeper, now)).toBe("dispute");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 1_500 }), me, keeper, now)).toBe("finalize");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 1_500, client: other, provider: me }), me, keeper, now)).toBe("finalize");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 3_000, disputed: true }), me, keeper, now)).toBeNull();
  });

  it("ignores jobs that are not the wallet's, and settled ones", () => {
    expect(classify(job({ client: other }), me, keeper, now)).toBeNull();
    expect(classify(job({ status: JobStatus.Completed }), me, keeper, now)).toBeNull();
  });
});

describe("walletInbox", () => {
  it("groups in the order a person should act and counts the wallet's jobs", () => {
    const jobs = [
      job({ id: 1n, status: JobStatus.Submitted, challengeEnd: 500 }),
      job({ id: 2n, status: JobStatus.Funded, client: other, provider: me }),
      job({ id: 3n, client: other }),
      job({ id: 4n, budget: 0n }),
    ];
    const groups = walletInbox(jobs, me, keeper, 2_000);
    expect(groups.map((group) => [group.kind, group.jobs.map((entry) => entry.id)])).toEqual([
      ["submit", [2n]],
      ["budget", [4n]],
      ["finalize", [1n]],
    ]);
    expect(walletJobCount(jobs, me)).toBe(3);
    expect(walletInbox(jobs, undefined, keeper, 2_000)).toEqual([]);
  });
});
