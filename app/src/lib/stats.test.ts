import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import type { JobSummary } from "./square";
import { liveStats, matchesQuery, relativeTime, released } from "./stats";

const job = (over: Partial<JobSummary>): JobSummary => ({
  id: 1n,
  client: "0x00000000000000000000000000000000000000Aa",
  provider: "0x00000000000000000000000000000000000000Bb",
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

describe("liveStats", () => {
  it("counts as escrowed only what the kernel still holds, and as settled only what it released", () => {
    const stats = liveStats({
      counter: 12n,
      scanned: 3,
      jobs: [
        job({ id: 12n, status: JobStatus.Completed, fundedAt: 1_100, submittedAt: 1_200, budget: 3_000_000n, providerBps: 10_000 }),
        job({ id: 11n, status: JobStatus.Funded, fundedAt: 1_500 }),
        job({ id: 10n }),
      ],
    });
    expect(stats).toEqual({ totalJobs: 12n, escrowed: 1_000_000n, settled: 2_955_000n, completed: 1, active: 1, lastActivity: 1_500, scanned: 3 });
  });

  it("drops a refunded job out of the escrow total instead of keeping it there for ever", () => {
    const jobs = [
      job({ id: 3n, status: JobStatus.Submitted, fundedAt: 1_100, submittedAt: 1_200, budget: 5_000_000n }),
      job({ id: 2n, status: JobStatus.Expired, fundedAt: 1_050, budget: 7_000_000n }),
      job({ id: 1n, status: JobStatus.Rejected, fundedAt: 1_000, budget: 9_000_000n }),
    ];
    const stats = liveStats({ counter: 3n, scanned: 3, jobs });
    expect(stats.escrowed).toBe(5_000_000n);
    expect(stats.settled).toBe(0n);
    expect(stats.active).toBe(1);
  });

  it("takes the fees and the arbiters' split off the settled total", () => {
    const stats = liveStats({
      counter: 1n,
      scanned: 1,
      jobs: [job({ id: 1n, status: JobStatus.Completed, fundedAt: 1_100, submittedAt: 1_200, budget: 1_000_000n, providerBps: 4_000 })],
    });
    expect(stats.settled).toBe(394_000n);
  });
});

describe("released", () => {
  it("agrees with SquareJob.complete on the deployed fee basis points", () => {
    expect(released(job({ budget: 1_000_000n, platformFeeBP: 100, evaluatorFeeBP: 50, providerBps: 10_000 }))).toBe(985_000n);
    expect(released(job({ budget: 1_000_000n, platformFeeBP: 100, evaluatorFeeBP: 50, providerBps: 0 }))).toBe(985_000n);
    expect(released(job({ budget: 1_000_000n, platformFeeBP: 0, evaluatorFeeBP: 0, providerBps: 10_000 }))).toBe(1_000_000n);
  });
});

describe("relativeTime", () => {
  it("speaks in the largest unit that fits", () => {
    expect(relativeTime(990, 1_000)).toBe("just now");
    expect(relativeTime(1_000, 1_090)).toBe("1 minute ago");
    expect(relativeTime(1_000, 8_200)).toBe("2 hours ago");
    expect(relativeTime(0, 3 * 86_400)).toBe("3 days ago");
  });
});

describe("matchesQuery", () => {
  it("matches an exact id or an address fragment, case-insensitively", () => {
    const entry = job({ id: 12n });
    expect(matchesQuery(entry, "")).toBe(true);
    expect(matchesQuery(entry, "12")).toBe(true);
    expect(matchesQuery(entry, "#12")).toBe(true);
    expect(matchesQuery(entry, "1")).toBe(false);
    expect(matchesQuery(entry, "0000BB")).toBe(true);
    expect(matchesQuery(entry, "dead")).toBe(false);
  });
});
