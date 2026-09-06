import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { memoryRateLimitStore, postgresRateLimitStore, rateLimitMiddleware, rateLimiter } from "../src/rateLimit.js";
import type { RateLimitDecision } from "../src/rateLimit.js";
import type { SqlClient } from "../src/sql.js";

const keyOf = (ip: string): string => ip;

describe("rateLimiter", () => {
  it("allows three requests per window and refuses the fourth", async () => {
    const clock = 10_000;
    const limiter = rateLimiter(memoryRateLimitStore(), { limit: 3, windowMs: 1_000, keyOf, now: () => clock });
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 4; i += 1) decisions.push(await limiter.check("1.1.1.1"));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((decision) => decision.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions.map((decision) => decision.count)).toEqual([1, 2, 3, 4]);
    expect(decisions[3]?.resetAt).toBe(11_000);
    expect((await limiter.check("2.2.2.2")).allowed).toBe(true);
  });

  it("starts a fresh count in the next window", async () => {
    let clock = 10_000;
    const limiter = rateLimiter(memoryRateLimitStore(), { limit: 3, windowMs: 1_000, keyOf, now: () => clock });
    for (let i = 0; i < 4; i += 1) await limiter.check("1.1.1.1");
    clock = 11_000;
    const decision = await limiter.check("1.1.1.1");
    expect(decision).toEqual({ allowed: true, limit: 3, remaining: 2, resetAt: 12_000, count: 1 });
  });

  it("rejects non-positive limits and windows", () => {
    expect(() => rateLimiter(memoryRateLimitStore(), { limit: 0, windowMs: 1_000, keyOf })).toThrow(RangeError);
    expect(() => rateLimiter(memoryRateLimitStore(), { limit: 3, windowMs: 0, keyOf })).toThrow(RangeError);
  });

  it("survives a limiter restart only when the store survives", async () => {
    const clock = 10_000;
    const options = { limit: 3, windowMs: 1_000, keyOf, now: () => clock };
    const store = memoryRateLimitStore();
    const beforeRestart = rateLimiter(store, options);
    for (let i = 0; i < 3; i += 1) await beforeRestart.check("1.1.1.1");

    const sameStore = rateLimiter(store, options);
    expect((await sameStore.check("1.1.1.1")).allowed).toBe(false);

    const freshStore = rateLimiter(memoryRateLimitStore(), options);
    expect((await freshStore.check("1.1.1.1")).allowed).toBe(true);
  });
});

describe("postgresRateLimitStore", () => {
  function countingDb() {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const counts = new Map<string, number>();
    const db: SqlClient = {
      async query(text, params) {
        calls.push({ text, params });
        if (text.startsWith("delete")) return { rows: [] };
        const id = `${String(params[0])}|${String(params[1])}`;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return { rows: [{ count }] };
      },
    };
    return { db, calls };
  }

  it("increments with one upsert per call and returns the row count", async () => {
    const { db, calls } = countingDb();
    const store = postgresRateLimitStore(db);
    expect(await store.increment("ip:1.1.1.1", 10_000)).toBe(1);
    expect(await store.increment("ip:1.1.1.1", 10_000)).toBe(2);
    expect(await store.increment("ip:1.1.1.1", 11_000)).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.text).toMatch(/insert into rate_limits \(bucket, window_start, count\)/);
    expect(calls[0]?.text).toMatch(/on conflict \(bucket, window_start\) do update set count = rate_limits\.count \+ 1/);
    expect(calls[0]?.text).toMatch(/returning count/);
    expect(calls[0]?.params).toEqual(["ip:1.1.1.1", new Date(10_000).toISOString()]);
  });

  it("drives the limiter to a refusal from the database count", async () => {
    const { db } = countingDb();
    const limiter = rateLimiter(postgresRateLimitStore(db), { limit: 3, windowMs: 1_000, keyOf, now: () => 10_000 });
    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i += 1) allowed.push((await limiter.check("1.1.1.1")).allowed);
    expect(allowed).toEqual([true, true, true, false]);
  });

  it("parses counts that drivers hand back as text", async () => {
    const db: SqlClient = { async query() { return { rows: [{ count: "7" }] }; } };
    expect(await postgresRateLimitStore(db).increment("b", 0)).toBe(7);
  });

  it("prunes windows older than a cutoff", async () => {
    const { db, calls } = countingDb();
    await postgresRateLimitStore(db).prune(9_000);
    expect(calls[0]?.text).toMatch(/delete from rate_limits where window_start < \$1::timestamptz/);
    expect(calls[0]?.params).toEqual([new Date(9_000).toISOString()]);
  });
});

describe("rateLimitMiddleware", () => {
  function build(now: () => number) {
    const app = new Hono();
    app.use(
      "*",
      rateLimitMiddleware(memoryRateLimitStore(), {
        limit: 3,
        windowMs: 1_000,
        keyOf: (c) => c.req.header("x-client") ?? "anonymous",
        now,
      })
    );
    app.get("/", (c) => c.text("ok"));
    app.get("/raw", () => new Response("raw"));
    return app;
  }

  it("sets RateLimit headers, answers 429 with Retry-After, and resets in the next window", async () => {
    let clock = 10_000;
    const app = build(() => clock);
    const responses: Response[] = [];
    for (let i = 0; i < 4; i += 1) responses.push(await app.request("/", { headers: { "x-client": "a" } }));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(responses[0]?.headers.get("ratelimit-limit")).toBe("3");
    expect(responses[0]?.headers.get("ratelimit-remaining")).toBe("2");
    expect(responses[0]?.headers.get("ratelimit-reset")).toBe("1");
    expect(responses[2]?.headers.get("ratelimit-remaining")).toBe("0");
    expect(responses[3]?.headers.get("retry-after")).toBe("1");
    expect(responses[3]?.headers.get("ratelimit-remaining")).toBe("0");
    expect(await responses[3]?.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 1 });

    expect((await app.request("/", { headers: { "x-client": "b" } })).status).toBe(200);

    clock = 11_000;
    const next = await app.request("/", { headers: { "x-client": "a" } });
    expect(next.status).toBe(200);
    expect(next.headers.get("ratelimit-remaining")).toBe("2");
  });

  it("keeps the headers when the handler returns a raw Response", async () => {
    const app = build(() => 10_000);
    const response = await app.request("/raw", { headers: { "x-client": "a" } });
    expect(await response.text()).toBe("raw");
    expect(response.headers.get("ratelimit-limit")).toBe("3");
    expect(response.headers.get("ratelimit-remaining")).toBe("2");
  });
});
