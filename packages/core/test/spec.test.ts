import { describe, expect, it } from "vitest";
import {
  canonicalSpec,
  specDescription,
  SpecError,
  specHash,
  specHashFromDescription,
  specMatchesDescription,
} from "../src/index.js";

describe("canonicalSpec", () => {
  it("sorts keys recursively and drops whitespace", () => {
    expect(canonicalSpec({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it("orders keys by UTF-16 code units as RFC 8785 requires", () => {
    expect(canonicalSpec({ "é": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"é":1}');
  });

  it("serialises numbers the ES way", () => {
    expect(canonicalSpec({ x: 1e21, y: 1.0, z: 0.000001, w: 100 })).toBe('{"w":100,"x":1e+21,"y":1,"z":0.000001}');
  });

  it("refuses values that are not JSON data", () => {
    expect(() => canonicalSpec(undefined)).toThrow(SpecError);
    expect(() => canonicalSpec(() => 1)).toThrow(SpecError);
  });
});

describe("specHash", () => {
  it("is keccak256 of the canonical UTF-8 bytes, matching cast keccak", () => {
    expect(specHash({ b: [true, "x"], a: 1 })).toBe(
      "0x66cc9874134e0dfbb9293ffd8726b99486e561dcee3dd781fb6274d6ef06b606",
    );
  });

  it("is order independent", () => {
    expect(specHash({ a: 1, b: 2 })).toBe(specHash({ b: 2, a: 1 }));
  });
});

describe("specDescription", () => {
  it("round trips through the description string", () => {
    const spec = { task: "translate", words: 1200, deadline: "2026-09-30T00:00:00Z" };
    const description = specDescription(spec);
    expect(description.startsWith("spec:0x")).toBe(true);
    expect(specHashFromDescription(description)).toBe(specHash(spec));
    expect(specMatchesDescription(spec, description)).toBe(true);
    expect(specMatchesDescription({ ...spec, words: 1201 }, description)).toBe(false);
  });

  it("returns undefined for descriptions that carry no hash", () => {
    expect(specHashFromDescription("free text")).toBeUndefined();
    expect(specHashFromDescription("spec:0x1234")).toBeUndefined();
  });
});
