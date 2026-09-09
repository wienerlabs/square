import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  hashRequest,
  idempotencyMiddleware,
  idempotencyScope,
  memoryIdempotencyStore,
  postgresIdempotencyStore,
  withIdempotency,
} from "../src/idempotency.js";
import type { HandlerResponse, IdempotencyStore } from "../src/idempotency.js";
import type { SqlClient } from "../src/sql.js";

describe("hashRequest", () => {
  it("ignores key order and method case and yields sha256 hex", () => {
    const first = hashRequest({ method: "post", path: "/orders", body: { b: 1, a: [1, { d: 2, c: 3 }] }, actor: "0xabc" });
    const second = hashRequest({ method: "POST", path: "/orders", body: { a: [1, { c: 3, d: 2 }], b: 1 }, actor: "0xabc" });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the actor, the path and the body", () => {
    const base = hashRequest({ method: "POST", path: "/orders", body: { item: "tea" }, actor: "0xabc" });
    expect(hashRequest({ method: "POST", path: "/orders", body: { item: "tea" }, actor: "0xdef" })).not.toBe(base);
    expect(hashRequest({ method: "POST", path: "/orders/1", body: { item: "tea" }, actor: "0xabc" })).not.toBe(base);
    expect(hashRequest({ method: "POST", path: "/orders", body: { item: "coffee" }, actor: "0xabc" })).not.toBe(base);
  });

  it("treats a missing body and actor as null", () => {
    expect(hashRequest({ method: "GET", path: "/" })).toBe(hashRequest({ method: "GET", path: "/", body: null, actor: null }));
  });
});

describe("withIdempotency", () => {
  const request = { scope: "orders", key: "k1", requestHash: "h1" };

  it("runs the handler once and replays the stored response for the same key and hash", async () => {
    const handler = vi.fn(async (): Promise<HandlerResponse> => ({ status: 201, body: { id: 7 } }));
    const execute = withIdempotency(memoryIdempotencyStore(), handler);
    expect(await execute(request)).toEqual({ source: "handler", status: 201, body: { id: 7 } });
    expect(await execute(request)).toEqual({ source: "replay", status: 201, body: { id: 7 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when the key is reused with a different hash", async () => {
    const handler = vi.fn(async (): Promise<HandlerResponse> => ({ status: 201, body: { id: 7 } }));
    const execute = withIdempotency(memoryIdempotencyStore(), handler);
    await execute(request);
    expect(await execute({ scope: "orders", key: "k1", requestHash: "h2" })).toEqual({
      source: "conflict",
      status: 409,
      body: { error: "idempotency_key_reused" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("re-processes once the stored entry has expired", async () => {
    let clock = 1_000;
    const handler = vi.fn(async (): Promise<HandlerResponse> => ({ status: 200, body: { at: clock } }));
    const execute = withIdempotency(memoryIdempotencyStore({ now: () => clock }), handler, { ttlMs: 500 });
    await execute(request);
    clock += 499;
    expect((await execute(request)).source).toBe("replay");
    clock += 2;
    expect(await execute(request)).toEqual({ source: "handler", status: 200, body: { at: 1_501 } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not store responses the policy rejects, so a 500 can be retried", async () => {
    let calls = 0;
    const handler = async (): Promise<HandlerResponse> => {
      calls += 1;
      return calls === 1 ? { status: 500, body: { error: "boom" } } : { status: 201, body: { id: 1 } };
    };
    const execute = withIdempotency(memoryIdempotencyStore(), handler);
    expect((await execute(request)).status).toBe(500);
    expect(await execute(request)).toEqual({ source: "handler", status: 201, body: { id: 1 } });
    expect((await execute(request)).source).toBe("replay");
  });

  it("collapses concurrent duplicates inside one process", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (): Promise<HandlerResponse> => {
      await gate;
      return { status: 201, body: { id: 1 } };
    });
    const execute = withIdempotency(memoryIdempotencyStore(), handler);
    const both = Promise.all([execute(request), execute(request)]);
    await Promise.resolve();
    release?.();
    const [first, second] = await both;
    expect(first).toEqual({ source: "handler", status: 201, body: { id: 1 } });
    expect(second).toEqual({ source: "replay", status: 201, body: { id: 1 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns the first writer's response when the store already holds the key at write time", async () => {
    const stored = { requestHash: "h1", status: 200, body: { winner: "other-process" }, expiresAt: Number.MAX_SAFE_INTEGER };
    const store: IdempotencyStore = {
      async get() {
        return undefined;
      },
      async putIfAbsent() {
        return { status: "exists", stored };
      },
    };
    const execute = withIdempotency(store, async () => ({ status: 201, body: { winner: "me" } }));
    expect(await execute(request)).toEqual({ source: "replay", status: 200, body: { winner: "other-process" } });
    expect(await execute({ scope: "orders", key: "k1", requestHash: "h2" })).toMatchObject({ source: "conflict", status: 409 });
  });
});

describe("postgresIdempotencyStore", () => {
  function fakeDb(script: Array<Array<Record<string, unknown>>>) {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const db: SqlClient = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: script.shift() ?? [] };
      },
    };
    return { db, calls };
  }
  const hash = "ab".repeat(32);

  it("claims with a single upsert guarded by expiry and reports stored", async () => {
    const { db, calls } = fakeDb([[{ key: "k1" }]]);
    const store = postgresIdempotencyStore(db, { now: () => 1_000 });
    expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 1 } }, 60_000)).toEqual({ status: "stored" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/insert into idempotency_keys/);
    expect(calls[0]?.text).toMatch(/decode\(\$3, 'hex'\)/);
    expect(calls[0]?.text).toMatch(/on conflict \(scope, key\) do update/);
    expect(calls[0]?.text).toMatch(/where idempotency_keys\.expires_at <= now\(\)/);
    expect(calls[0]?.text).toMatch(/returning key/);
    expect(calls[0]?.params).toEqual(["orders", "k1", hash, 201, JSON.stringify({ id: 1 }), new Date(61_000).toISOString()]);
  });

  it("reads the live row back when the claim conflicts", async () => {
    const other = "cd".repeat(32);
    const { db, calls } = fakeDb([
      [],
      [{ request_hash: Buffer.from(other, "hex"), status: 200, response: { ok: true }, expires_at: new Date(5_000) }],
    ]);
    const store = postgresIdempotencyStore(db);
    expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: null }, 1_000)).toEqual({
      status: "exists",
      stored: { requestHash: other, status: 200, body: { ok: true }, expiresAt: 5_000 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toMatch(/expires_at > now\(\)/);
    expect(calls[1]?.params).toEqual(["orders", "k1"]);
  });

  it("maps raw driver values: hex-encoded bytea text, json text, string counts and ISO timestamps", async () => {
    const { db } = fakeDb([[{ request_hash: `\\x${hash}`, status: "200", response: '{"ok":true}', expires_at: "1970-01-01T00:00:05.000Z" }]]);
    const store = postgresIdempotencyStore(db);
    expect(await store.get("orders", "k1")).toEqual({ requestHash: hash, status: 200, body: { ok: true }, expiresAt: 5_000 });
  });

  it("returns undefined when there is no live row", async () => {
    const { db, calls } = fakeDb([[]]);
    expect(await postgresIdempotencyStore(db).get("orders", "missing")).toBeUndefined();
    expect(calls[0]?.params).toEqual(["orders", "missing"]);
  });
});

describe("idempotencyMiddleware", () => {
  function build(store: IdempotencyStore, required = false) {
    const app = new Hono();
    let counter = 0;
    app.use("/orders", idempotencyMiddleware(store, { scope: "orders", required, actorOf: (c) => c.req.header("x-tenant") }));
    app.post("/orders", async (c) => {
      const body = await c.req.json<{ item: string }>();
      counter += 1;
      return c.json({ id: counter, item: body.item }, 201);
    });
    app.get("/orders", (c) => c.json({ list: true }));
    const postAs = (tenant: string | undefined, key: string | undefined, body: unknown) =>
      app.request("/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(tenant === undefined ? {} : { "x-tenant": tenant }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body: JSON.stringify(body),
      });
    const post = (key: string | undefined, body: unknown) => postAs("tenant-a", key, body);
    return { app, post, postAs };
  }

  it("replays the first response for a repeated key and hash and answers 409 on reuse with another body", async () => {
    const { post } = build(memoryIdempotencyStore());
    const first = await post("k1", { item: "tea" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toEqual({ id: 1, item: "tea" });

    const replay = await post("k1", { item: "tea" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("content-type")).toContain("application/json");
    expect(await replay.json()).toEqual(firstBody);

    const conflict = await post("k1", { item: "coffee" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_key_reused" });

    const fresh = await post("k2", { item: "coffee" });
    expect(await fresh.json()).toEqual({ id: 2, item: "coffee" });
  });

  it("gives each caller its own namespace: the same key and body never crosses tenants", async () => {
    const { postAs } = build(memoryIdempotencyStore());
    const a = await postAs("tenant-a", "1", { item: "tea" });
    const b = await postAs("tenant-b", "1", { item: "tea" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
    expect(await a.json()).toEqual({ id: 1, item: "tea" });
    expect(await b.json()).toEqual({ id: 2, item: "tea" });

    const replayA = await postAs("tenant-a", "1", { item: "tea" });
    expect(replayA.headers.get("idempotent-replayed")).toBe("true");
    expect(await replayA.json()).toEqual({ id: 1, item: "tea" });
  });

  it("does not let one caller's key make another caller's key conflict", async () => {
    const { postAs } = build(memoryIdempotencyStore());
    await postAs("tenant-a", "1", { item: "tea" });
    const b = await postAs("tenant-b", "1", { item: "coffee" });
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual({ id: 2, item: "coffee" });
  });

  it("stores under a scope that carries the actor", async () => {
    const store = memoryIdempotencyStore();
    const { postAs } = build(store);
    await postAs("tenant-a", "k1", { item: "tea" });
    expect(await store.get(idempotencyScope("orders", "tenant-a"), "k1")).toBeDefined();
    expect(await store.get("orders", "k1")).toBeUndefined();
    expect(await store.get(idempotencyScope("orders", "tenant-b"), "k1")).toBeUndefined();
  });

  it("refuses a keyed request whose caller actorOf cannot name", async () => {
    const { postAs } = build(memoryIdempotencyStore());
    const anonymous = await postAs(undefined, "k1", { item: "tea" });
    expect(anonymous.status).toBe(400);
    expect(await anonymous.json()).toEqual({ error: "idempotency_actor_unknown" });
  });

  it("lets requests without a key through unless the key is required", async () => {
    const relaxed = build(memoryIdempotencyStore());
    expect((await relaxed.post(undefined, { item: "tea" })).status).toBe(201);
    expect((await relaxed.post(undefined, { item: "tea" })).status).toBe(201);

    const strict = build(memoryIdempotencyStore(), true);
    const refused = await strict.post(undefined, { item: "tea" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "idempotency_key_required" });
  });

  it("ignores safe methods even when they carry a key", async () => {
    const { app } = build(memoryIdempotencyStore());
    const first = await app.request("/orders", { headers: { "idempotency-key": "k1" } });
    const second = await app.request("/orders", { headers: { "idempotency-key": "k1" } });
    expect(first.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
  });
});
