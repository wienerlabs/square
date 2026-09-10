import { JobStatus } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { disputeAvailable } from "./actions";
import { chainClockOffset, chainNow, clockSkew, CLOCK_SKEW_NOTICE_SECONDS } from "./clock";

const keeper = "0x00000000000000000000000000000000000000Cc" as const;
const otherEvaluator = "0x00000000000000000000000000000000000000Dd" as const;

const SUBMITTED_AT = 1_800_000_000;
const CHALLENGE_WINDOW = 120;
const CHALLENGE_END = SUBMITTED_AT + CHALLENGE_WINDOW;
const BROWSER_AHEAD_BY = 120;

const submitted = { evaluator: keeper, status: JobStatus.Submitted, challengeEnd: CHALLENGE_END };

function browserClockMs(chainSecond: number): number {
  return (chainSecond + BROWSER_AHEAD_BY) * 1_000;
}

describe("a browser clock two minutes ahead of the chain", () => {
  const offset = chainClockOffset(SUBMITTED_AT, browserClockMs(SUBMITTED_AT));

  it("reads the skew off the block timestamp and names it as the whole challenge window", () => {
    expect(offset).toBe(-BROWSER_AHEAD_BY);
    expect(clockSkew(offset)).toEqual({ seconds: BROWSER_AHEAD_BY, ahead: true });
  });

  it("keeps the dispute available for every second the chain still accepts it", () => {
    for (let second = 0; second < CHALLENGE_WINDOW; second += 1) {
      const now = chainNow(offset, browserClockMs(SUBMITTED_AT + second));
      expect(now).toBe(SUBMITTED_AT + second);
      expect(disputeAvailable(submitted, keeper, now)).toBe(true);
    }
    expect(disputeAvailable(submitted, keeper, chainNow(offset, browserClockMs(CHALLENGE_END)))).toBe(false);
  });

  it("hides the dispute for the whole window when the same gate reads the browser clock instead", () => {
    for (let second = 0; second < CHALLENGE_WINDOW; second += 1) {
      const browserNow = Math.floor(browserClockMs(SUBMITTED_AT + second) / 1_000);
      expect(disputeAvailable(submitted, keeper, browserNow)).toBe(false);
    }
  });
});

describe("clockSkew", () => {
  it("stays quiet below the threshold and names the direction above it", () => {
    expect(clockSkew(0)).toBeNull();
    expect(clockSkew(CLOCK_SKEW_NOTICE_SECONDS - 1)).toBeNull();
    expect(clockSkew(-(CLOCK_SKEW_NOTICE_SECONDS - 1))).toBeNull();
    expect(clockSkew(CLOCK_SKEW_NOTICE_SECONDS)).toEqual({ seconds: CLOCK_SKEW_NOTICE_SECONDS, ahead: false });
    expect(clockSkew(-CLOCK_SKEW_NOTICE_SECONDS)).toEqual({ seconds: CLOCK_SKEW_NOTICE_SECONDS, ahead: true });
  });
});

describe("chainNow", () => {
  it("falls back to the browser clock when no block has been read yet", () => {
    expect(chainNow(0, 1_800_000_500_000)).toBe(1_800_000_500);
  });
});

describe("disputeAvailable", () => {
  it("follows KeeperEvaluator.dispute: submitted, evaluated by the keeper, and before the window ends", () => {
    expect(disputeAvailable(submitted, keeper, CHALLENGE_END - 1)).toBe(true);
    expect(disputeAvailable(submitted, keeper, CHALLENGE_END)).toBe(false);
    expect(disputeAvailable({ ...submitted, status: JobStatus.Funded }, keeper, SUBMITTED_AT)).toBe(false);
    expect(disputeAvailable({ ...submitted, evaluator: otherEvaluator }, keeper, SUBMITTED_AT)).toBe(false);
  });
});
