import { describe, it, expect } from "vitest";
import { readConfig } from "../src/config.js";

describe("config", () => {
  it("reads the JSON map", () => {
    const c = readConfig({ DRIVER_RPC: '{"5042002":"https://a"}' } as never);
    expect(c.rpc).toEqual({ 5042002: "https://a" });
  });

  it("reads per-chain variables", () => {
    const c = readConfig({ RPC_5042002: "https://a", RPC_1: "https://b" } as never);
    expect(c.rpc).toEqual({ 5042002: "https://a", 1: "https://b" });
  });

  it("lets a per-chain variable override the map", () => {
    const c = readConfig({
      DRIVER_RPC: '{"5042002":"https://from-json"}',
      RPC_5042002: "https://from-var",
    } as never);
    expect(c.rpc[5042002]).toBe("https://from-var");
  });

  it("refuses to start with no chains", () => {
    expect(() => readConfig({} as never)).toThrow(/No chains configured/);
  });

  it("refuses malformed input rather than starting half-configured", () => {
    expect(() => readConfig({ DRIVER_RPC: "not json" } as never)).toThrow(/not valid JSON/);
    expect(() => readConfig({ DRIVER_RPC: "[]" } as never)).toThrow(/must be an object/);
    expect(() => readConfig({ DRIVER_RPC: '{"abc":"https://a"}' } as never)).toThrow(/not a chain id/);
  });

  it("parses an optional registry allowlist", () => {
    const c = readConfig({ RPC_1: "https://a", DRIVER_ALLOWED_REGISTRIES: "0xaa, 0xbb" } as never);
    expect(c.allowedRegistries).toEqual(["0xaa", "0xbb"]);
    expect(readConfig({ RPC_1: "https://a" } as never).allowedRegistries).toBeUndefined();
  });
});
