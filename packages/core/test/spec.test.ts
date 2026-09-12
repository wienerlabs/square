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

  // The hash is a commitment, so the canonical text must be JSON a parser can
  // read back to a value that canonicalises to the same text. Before #298 a
  // nested function came out as {"f":undefined} and was hashed, and a bigint
  // threw a TypeError where SpecError was promised.
  describe("refuses what is not JSON data at any depth, as SpecError, and says where", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const [label, value, where] of [
      ["a nested function", { f: () => 1 }, "spec.f is a function"],
      ["undefined in an array", [1, undefined, 2], "spec[1] is undefined"],
      ["a function in an array", { a: [1, () => 1] }, "spec.a[1] is a function"],
      ["a bigint", { amount: 5n }, "spec.amount is a bigint"],
      ["NaN", { x: NaN }, "spec.x is NaN"],
      ["Infinity", { x: -Infinity }, "spec.x is -Infinity"],
      ["a symbol", { s: Symbol("x") }, "spec.s is a symbol"],
      ["a cycle", cyclic, "spec.self refers back to itself"],
      ["a Date", { when: new Date(0) }, "spec.when is a Date, not a plain object"],
      ["a Map", { m: new Map() }, "spec.m is a Map, not a plain object"],
    ] as const) {
      it(label, () => {
        expect(() => canonicalSpec(value)).toThrow(SpecError);
        expect(() => canonicalSpec(value)).toThrow(where);
        expect(() => specHash(value)).toThrow(SpecError);
      });
    }

    it("keeps JSON.stringify's own rules: an undefined value drops its key, -0 is 0", () => {
      expect(canonicalSpec({ a: undefined, b: 1 })).toBe('{"b":1}');
      expect(specHash({ a: undefined, b: 1 })).toBe(specHash({ b: 1 }));
      expect(canonicalSpec({ n: -0 })).toBe('{"n":0}');
    });

    it("accepts null-prototype objects and nested plain data", () => {
      const bare = Object.assign(Object.create(null) as Record<string, unknown>, { z: [null, true, "s", 1.5, { k: [] }] });
      expect(canonicalSpec(bare)).toBe('{"z":[null,true,"s",1.5,{"k":[]}]}');
    });
  });

  it("every canonical text parses back to a value that canonicalises to itself", () => {
    for (const value of [null, true, "x", 0, 1e21, [], {}, { b: [1, { a: null }], a: "é" }, [[[]]]]) {
      const text = canonicalSpec(value);
      expect(canonicalSpec(JSON.parse(text))).toBe(text);
    }
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
