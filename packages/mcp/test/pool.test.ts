import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolResultCache } from "../src/cache.js";
import { ToolPool } from "../src/pool.js";
import { startToolServer, type ToolServer } from "./helpers/toolServer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ToolPool", () => {
  let weather: ToolServer;
  let docs: ToolServer;
  beforeAll(async () => {
    weather = await startToolServer({ name: "weather" });
    docs = await startToolServer({ name: "docs" });
  });
  afterAll(async () => {
    await weather.close();
    await docs.close();
  });

  it("refuses a configuration it could not name tools under", () => {
    expect(() => new ToolPool({ servers: [{ name: "a__b", url: "http://127.0.0.1:1/mcp" }] })).toThrow(/without "__"/);
    expect(() => new ToolPool({ servers: [{ name: "a b", url: "http://127.0.0.1:1/mcp" }] })).toThrow(/letters, digits/);
    expect(() => new ToolPool({ servers: [{ name: "a", url: "http://x/mcp" }, { name: "a", url: "http://y/mcp" }] })).toThrow(/configured twice/);
    expect(() => new ToolPool({ servers: [{ name: "a", url: "not a url" }] })).toThrow(/not a URL/);
    expect(() => new ToolPool({ servers: [{ name: "a", url: "ftp://x/mcp" }] })).toThrow(/http\(s\)/);
  });

  it("discovers every server's tools under qualified names, skipping a server that is down", async () => {
    const errors: string[] = [];
    const pool = new ToolPool({
      servers: [
        { name: "weather", url: weather.url },
        { name: "down", url: "http://127.0.0.1:9/mcp" },
        { name: "docs", url: docs.url },
      ],
      onError: (server, error) => errors.push(`${server}: ${error instanceof Error ? error.message : String(error)}`),
      connectTimeoutMs: 2_000,
    });
    try {
      const tools = await pool.tools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("weather__forecast");
      expect(names).toContain("docs__forecast");
      expect(names.filter((n) => n.startsWith("down__"))).toEqual([]);
      expect(tools.find((t) => t.name === "weather__forecast")).toMatchObject({
        server: "weather",
        tool: "forecast",
        description: "Tomorrow's weather in a city.",
        inputSchema: { type: "object", required: ["city"] },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^down: /);
      expect(pool.status()).toMatchObject([
        { name: "weather", state: "connected", tools: 5 },
        { name: "down", state: "failed", tools: 0 },
        { name: "docs", state: "connected", tools: 5 },
      ]);
      expect(pool.status()[1]?.lastError).toBeTruthy();
    } finally {
      await pool.close();
    }
  });

  it("calls a tool, answers again from the cache, and reports what the tool said when it failed", async () => {
    const pool = new ToolPool({ servers: [{ name: "weather", url: weather.url }] });
    try {
      const before = weather.calls.length;
      const first = await pool.call("weather__forecast", { city: "Berlin", days: 2 });
      expect(first).toMatchObject({ ok: true, name: "weather__forecast", text: "Berlin: sunny for 2 days", cached: false });
      expect(first.durationMs).toBeGreaterThanOrEqual(0);
      const again = await pool.call("weather__forecast", { days: 2, city: "Berlin" });
      expect(again).toMatchObject({ ok: true, text: "Berlin: sunny for 2 days", cached: true, durationMs: 0 });
      expect(weather.calls.length - before).toBe(1);

      const structured = await pool.call("weather__structured", { q: "hi" });
      expect(structured).toMatchObject({ ok: true, text: "echo hi\n[resource_link]", structured: { echo: "hi" } });

      const boom = await pool.call("weather__boom");
      expect(boom).toMatchObject({ ok: false, failure: "tool-error", retryable: false, text: "the teapot is short and stout" });
      const boomAgain = await pool.call("weather__boom");
      expect(boomAgain.cached).toBe(false);
    } finally {
      await pool.close();
    }
  });

  it("names a tool nobody declares, without a network round trip for a server nobody configured", async () => {
    const pool = new ToolPool({ servers: [{ name: "weather", url: weather.url }] });
    try {
      expect(await pool.call("forecast", { city: "x" })).toMatchObject({ ok: false, failure: "unknown-tool", retryable: false });
      expect(await pool.call("docs__forecast", { city: "x" })).toMatchObject({ ok: false, failure: "unknown-tool" });
      expect(pool.status()[0]?.state).toBe("disconnected");
      expect(await pool.call("weather__nothing", {})).toMatchObject({ ok: false, failure: "unknown-tool", text: 'weather declares no tool named "nothing"' });
    } finally {
      await pool.close();
    }
  });

  it("times a call out, retryably, and caps a result's size", async () => {
    const pool = new ToolPool({ servers: [{ name: "weather", url: weather.url }], maxResultBytes: 64, callTimeoutMs: 100 });
    try {
      const slow = await pool.call("weather__slow", { ms: 400 });
      expect(slow).toMatchObject({ ok: false, failure: "timeout", retryable: true });
      expect(slow.text).toMatch(/did not answer within 100ms/);
      const fast = await pool.call("weather__slow", { ms: 10 }, { timeoutMs: 2_000 });
      expect(fast.ok).toBe(true);
      const big = await pool.call("weather__big", { n: 100 });
      expect(big).toMatchObject({ ok: false, failure: "too-large", retryable: false, text: "x".repeat(64) });
      // The pool is still connected: neither a timeout nor a large answer is a broken connection.
      expect(pool.status()[0]?.state).toBe("connected");
    } finally {
      await pool.close();
    }
  });

  it("lets an idle connection go, keeps what it learned, and reconnects on the next call", async () => {
    const initializes: string[] = [];
    const pool = new ToolPool({
      servers: [{ name: "weather", url: weather.url }],
      idleMs: 80,
      cache: false,
      fetch: async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes('"initialize"')) initializes.push(body);
        return fetch(input, init);
      },
    });
    try {
      // In use, it stays: every call restarts the idle clock.
      for (let i = 0; i < 6; i += 1) {
        await pool.call("weather__forecast", { city: "Oslo" });
        await sleep(40);
      }
      expect(initializes).toHaveLength(1);
      expect(pool.status()[0]?.state).toBe("connected");
      await sleep(250);
      expect(pool.status()[0]).toMatchObject({ state: "disconnected", tools: 5 });
      expect((await pool.tools()).map((t) => t.name)).toContain("weather__forecast");
      expect(initializes).toHaveLength(1);
      const again = await pool.call("weather__forecast", { city: "Oslo" });
      expect(again).toMatchObject({ ok: true, cached: false });
      expect(initializes).toHaveLength(2);
      expect(pool.status()[0]?.state).toBe("connected");
    } finally {
      await pool.close();
    }
  });

  it("reports a server that stopped answering as unreachable and starts over on the next call", async () => {
    const flaky = await startToolServer({ name: "flaky" });
    const pool = new ToolPool({ servers: [{ name: "flaky", url: flaky.url }], cache: false, connectTimeoutMs: 2_000 });
    try {
      expect((await pool.call("flaky__forecast", { city: "x" })).ok).toBe(true);
      await flaky.close();
      const gone = await pool.call("flaky__forecast", { city: "x" });
      expect(gone).toMatchObject({ ok: false, failure: "unreachable", retryable: true });
      expect(pool.status()[0]?.state).toBe("disconnected");
      const still = await pool.call("flaky__forecast", { city: "x" });
      expect(still).toMatchObject({ ok: false, failure: "unreachable", retryable: true });
      expect(pool.status()[0]?.state).toBe("failed");
    } finally {
      await pool.close();
    }
  });

  it("shares one cache when told to, and refuses work once closed", async () => {
    const cache = new ToolResultCache();
    const a = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache });
    const b = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache });
    await a.call("weather__forecast", { city: "Rome" });
    expect((await b.call("weather__forecast", { city: "Rome" })).cached).toBe(true);
    await a.close();
    await b.close();
    await expect(a.call("weather__forecast", { city: "Rome" })).rejects.toThrow(/closed/);
    await expect(a.tools()).rejects.toThrow(/closed/);
  });
});
