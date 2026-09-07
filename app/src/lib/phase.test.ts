import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { countVotes, jobPhase } from "./phase";

describe("jobPhase", () => {
  const now = 1_000;

  it("names the open and funded states", () => {
    expect(jobPhase({ status: JobStatus.Open, challengeEnd: 0, disputed: false }, now)).toBe("open");
    expect(jobPhase({ status: JobStatus.Funded, challengeEnd: 0, disputed: false }, now)).toBe("funded");
  });

  it("splits a submitted job by the window and the dispute flag", () => {
    expect(jobPhase({ status: JobStatus.Submitted, challengeEnd: 0, disputed: false }, now)).toBe("submitted");
    expect(jobPhase({ status: JobStatus.Submitted, challengeEnd: 2_000, disputed: false }, now)).toBe("in-window");
    expect(jobPhase({ status: JobStatus.Submitted, challengeEnd: 900, disputed: false }, now)).toBe("finalizable");
    expect(jobPhase({ status: JobStatus.Submitted, challengeEnd: 900, disputed: true }, now)).toBe("disputed");
  });

  it("passes the terminal states through", () => {
    expect(jobPhase({ status: JobStatus.Completed, challengeEnd: 0, disputed: false }, now)).toBe("completed");
    expect(jobPhase({ status: JobStatus.Rejected, challengeEnd: 0, disputed: false }, now)).toBe("rejected");
    expect(jobPhase({ status: JobStatus.Expired, challengeEnd: 0, disputed: false }, now)).toBe("expired");
  });
});

describe("countVotes", () => {
  it("counts the set bits of the vote mask", () => {
    expect(countVotes(0n)).toBe(0);
    expect(countVotes(0b101n)).toBe(2);
    expect(countVotes(0b111n)).toBe(3);
  });
});
