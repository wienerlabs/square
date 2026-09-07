import { describe, expect, it } from "vitest";
import { formatBps, formatCountdown, formatDuration, formatUsdc, parseUsdc, shortAddress, shortHash } from "./format";

describe("usdc formatting", () => {
  it("prints six decimal base units with grouping and at least two decimals", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc(1_234_567_890n)).toBe("1,234.56789");
    expect(formatUsdc(5_000n)).toBe("0.005");
    expect(formatUsdc(-2_500_000n)).toBe("-2.50");
  });

  it("parses what it prints and refuses the rest", () => {
    expect(parseUsdc("1,234.56789")).toBe(1_234_567_890n);
    expect(parseUsdc(" 0.5 ")).toBe(500_000n);
    expect(parseUsdc("1.2345678")).toBeNull();
    expect(parseUsdc("abc")).toBeNull();
  });
});

describe("durations and rates", () => {
  it("picks the two largest units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3_900)).toBe("1h 5m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });

  it("counts down and closes", () => {
    expect(formatCountdown(1_100, 1_000)).toBe("1m 40s left");
    expect(formatCountdown(900, 1_000)).toBe("Closed");
  });

  it("turns basis points into a trimmed percentage", () => {
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(50)).toBe("0.5%");
    expect(formatBps(2_000n)).toBe("20%");
  });
});

describe("shortening", () => {
  it("keeps the ends of an address and a hash", () => {
    expect(shortAddress("0x4f1397ea728005003cc351260bb5d7d00198da86")).toBe("0x4F13…dA86");
    expect(shortHash("0x" + "ab".repeat(32))).toBe("0xabababab…ababab");
    expect(shortAddress("not-an-address")).toBe("not-an-address");
  });
});
