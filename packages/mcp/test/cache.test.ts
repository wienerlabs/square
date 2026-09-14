import { describe, expect, it } from "vitest";
import { cacheKey, canonicalJson, ToolResultCache } from "../src/cache.js";
import type { ToolFailed, ToolSuccess } from "../src/types.js";

const success = (text: string): ToolSuccess => ({ ok: true, name: "w__f", text, durationMs: 7, cached: false });
const failure: ToolFailed = { ok: false, failure: "tool-error", retryable: false, name: "w__f", text: "no", durationMs: 1, cached: false };

describe("the cache key", () => {
  it("sorts keys at every depth, so argument order does not make a second entry", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
    expect(cacheKey("w__f", { city: "Berlin", days: 2 })).toBe(cacheKey("w__f", { days: 2, city: "Berlin" }));
  });

  it("keeps nested values apart, which the predecessor's replacer-array key did not", () => {
    // JSON.stringify(args, Object.keys(args).sort()) applies the key list at
    // every depth: both of these came out as {"city":{}} and shared an entry.
    const legacy = (args: Record<string, unknown>) => JSON.stringify(args, Object.keys(args).sort());
    expect(legacy({ city: { name: "Berlin" } })).toBe(legacy({ city: { name: "Paris" } }));
    expect(cacheKey("w__f", { city: { name: "Berlin" } })).not.toBe(cacheKey("w__f", { city: { name: "Paris" } }));
  });

  it("drops undefined values like JSON does and refuses what JSON refuses", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

describe("ToolResultCache", () => {
  it("answers a success again, marked cached, and never a failure", () => {
    const cache = new ToolResultCache();
    cache.set("w__f", { city: "Berlin" }, success("sunny"));
    cache.set("w__g", { city: "Berlin" }, failure);
    expect(cache.get("w__f", { city: "Berlin" })).toEqual({ ...success("sunny"), cached: true, durationMs: 0 });
    expect(cache.get("w__g", { city: "Berlin" })).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("forgets an entry after its ttl", () => {
    let now = 1_000;
    const cache = new ToolResultCache({ ttlMs: 100, now: () => now });
    cache.set("w__f", {}, success("a"));
    now = 1_099;
    expect(cache.get("w__f", {})?.text).toBe("a");
    now = 1_100;
    expect(cache.get("w__f", {})).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("is bounded, evicting the least recently used", () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set("w__f", { i: 1 }, success("1"));
    cache.set("w__f", { i: 2 }, success("2"));
    cache.get("w__f", { i: 1 });
    cache.set("w__f", { i: 3 }, success("3"));
    expect(cache.size).toBe(2);
    expect(cache.get("w__f", { i: 2 })).toBeUndefined();
    expect(cache.get("w__f", { i: 1 })?.text).toBe("1");
    expect(cache.get("w__f", { i: 3 })?.text).toBe("3");
    expect(() => new ToolResultCache({ maxEntries: 0 })).toThrow(RangeError);
  });
});
