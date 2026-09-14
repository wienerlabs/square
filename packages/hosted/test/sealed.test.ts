import { describe, expect, it } from "vitest";
import { deriveSealKey, isSealed, open, seal, SealError, SEALED_PREFIX } from "../src/sealed.js";

const key = deriveSealKey("an operator secret of some length");
const context = "hosted-agent:7";

describe("sealing an institution's key", () => {
  it("round-trips, and two seals of one key differ", () => {
    const sealed = seal("sk-ant-example", key, context);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(open(sealed, key, context)).toBe("sk-ant-example");
    expect(seal("sk-ant-example", key, context)).not.toBe(sealed);
  });

  it("does not open with another secret, for another agent, or after a byte changed", () => {
    const sealed = seal("sk-ant-example", key, context);
    expect(() => open(sealed, deriveSealKey("a different operator secret"), context)).toThrow(SealError);
    expect(() => open(sealed, key, "hosted-agent:8")).toThrow(/does not open with this key for this agent/);
    // The first character is six bits of the random iv; any other character is a different iv.
    const body = sealed.slice(SEALED_PREFIX.length);
    const flipped = SEALED_PREFIX + (body[0] === "A" ? "B" : "A") + body.slice(1);
    expect(() => open(flipped, key, context)).toThrow(SealError);
  });

  it("refuses what is not sealed, and a secret too short to be one", () => {
    expect(() => open("sk-ant-plain", key, context)).toThrow(/not a sealed value/);
    expect(() => open(`${SEALED_PREFIX}AAAA`, key, context)).toThrow(/too short/);
    expect(() => deriveSealKey("short")).toThrow(/at least 16 characters/);
    expect(() => seal("x", Buffer.alloc(16), context)).toThrow(/32 bytes/);
  });
});
