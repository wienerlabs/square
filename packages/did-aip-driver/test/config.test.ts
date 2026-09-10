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

  it("holds the per-chain form to the chain id check the JSON form gets", () => {
    // RPC_<id> wins over DRIVER_RPC, so it used to be the unchecked form that
    // decided. {"0": ...} was refused; RPC_0 was accepted as chain 0.
    expect(() => readConfig({ RPC_0: "https://a" } as never)).toThrow(/RPC_0: "0" is not a chain id/);
    expect(readConfig({ RPC_0007: "https://a" } as never).rpc).toEqual({ 7: "https://a" });
  });

  it("validates the port at boot, in its own words", () => {
    const base = { RPC_1: "https://a" };
    expect(readConfig(base as never).port).toBe(8080);
    expect(readConfig({ ...base, DRIVER_PORT: "9090" } as never).port).toBe(9090);
    // listen(NaN) would otherwise throw ERR_SOCKET_BAD_PORT outside the
    // try/catch that server.ts wraps around readConfig, as a raw stack trace.
    for (const bad of ["abc", "", "0", "-1", "8080.5", "65536", "80abc"]) {
      expect(() => readConfig({ ...base, DRIVER_PORT: bad } as never), bad).toThrow(/^DRIVER_PORT: /);
    }
  });

  it("validates the timeout at boot, because NaN reaches setTimeout as 1 ms", () => {
    // Number("abc") is NaN; NaN !== undefined, so the resolver forwarded it,
    // and NaN ?? 10000 is NaN, so the fetcher did not fall back either. Node
    // then treats setTimeout(fn, NaN) as setTimeout(fn, 1): every agentURI
    // fetch aborted, every warning said "unreachable", and a deactivated agent
    // resolved as active with a 200.
    const base = { RPC_1: "https://a" };
    expect(readConfig(base as never).timeoutMs).toBe(10_000);
    expect(readConfig({ ...base, DRIVER_TIMEOUT_MS: "250" } as never).timeoutMs).toBe(250);
    for (const bad of ["abc", "", "0", "-5", "1.5", "1e3x"]) {
      expect(() => readConfig({ ...base, DRIVER_TIMEOUT_MS: bad } as never), bad).toThrow(/^DRIVER_TIMEOUT_MS: /);
    }
  });
});
