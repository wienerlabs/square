import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import type { JobSummary } from "./square";
import { liveStats, matchesQuery, relativeTime } from "./stats";

const job = (over: Partial<JobSummary>): JobSummary => ({
  id: 1n,
  client: "0x00000000000000000000000000000000000000Aa",
  provider: "0x00000000000000000000000000000000000000Bb",
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
  it("sums escrow, settlement and activity over the snapshot", () => {
    const stats = liveStats({
      counter: 12n,
      scanned: 3,
      jobs: [
        job({ id: 12n, status: JobStatus.Completed, fundedAt: 1_100, submittedAt: 1_200, budget: 3_000_000n }),
        job({ id: 11n, status: JobStatus.Funded, fundedAt: 1_500 }),
        job({ id: 10n }),
      ],
    });
    expect(stats).toEqual({ totalJobs: 12n, escrowed: 4_000_000n, settled: 3_000_000n, completed: 1, active: 1, lastActivity: 1_500, scanned: 3 });
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
