import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { classify, walletInbox, walletJobCount } from "./inbox";
import type { JobSummary } from "./square";

const me = "0x00000000000000000000000000000000000000Aa" as const;
const other = "0x00000000000000000000000000000000000000Bb" as const;

const job = (over: Partial<JobSummary>): JobSummary => ({
  id: 1n,
  client: me,
  provider: other,
  evaluator: "0x00000000000000000000000000000000000000Cc",
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
    expect(classify(job({ budget: 0n }), me, now)).toBe("budget");
    expect(classify(job({}), me, now)).toBe("fund");
    expect(classify(job({ provider: "0x0000000000000000000000000000000000000000" }), me, now)).toBeNull();
  });

  it("asks the provider for the deliverable while funded and live", () => {
    expect(classify(job({ status: JobStatus.Funded, client: other, provider: me }), me, now)).toBe("submit");
    expect(classify(job({ status: JobStatus.Funded }), me, now)).toBeNull();
    expect(classify(job({ status: JobStatus.Funded, expiredAt: 1_500 }), me, now)).toBe("refund");
    expect(classify(job({ status: JobStatus.Submitted, expiredAt: 1_500, challengeEnd: 0 }), me, now)).toBe("refund");
    expect(classify(job({ status: JobStatus.Submitted, expiredAt: 1_500, challengeEnd: 3_000 }), me, now)).toBeNull();
  });

  it("follows the challenge window for a submitted job", () => {
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 3_000 }), me, now)).toBe("dispute");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 1_500 }), me, now)).toBe("finalize");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 1_500, client: other, provider: me }), me, now)).toBe("finalize");
    expect(classify(job({ status: JobStatus.Submitted, challengeEnd: 3_000, disputed: true }), me, now)).toBeNull();
  });

  it("ignores jobs that are not the wallet's, and settled ones", () => {
    expect(classify(job({ client: other }), me, now)).toBeNull();
    expect(classify(job({ status: JobStatus.Completed }), me, now)).toBeNull();
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
    const groups = walletInbox(jobs, me, 2_000);
    expect(groups.map((group) => [group.kind, group.jobs.map((entry) => entry.id)])).toEqual([
      ["submit", [2n]],
      ["budget", [4n]],
      ["finalize", [1n]],
    ]);
    expect(walletJobCount(jobs, me)).toBe(3);
    expect(walletInbox(jobs, undefined, 2_000)).toEqual([]);
  });
});
