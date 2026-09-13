import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, type Database, type QueryResult } from "@squaresdk/data";
import {
  canonicalQuery,
  hashRequest,
  idempotencyMiddleware,
  idempotencyScope,
  memoryIdempotencyStore,
  pathWithCanonicalQuery,
  postgresIdempotencyStore,
  withIdempotency,
} from "../src/idempotency.js";
import type { HandlerResponse, IdempotencyMiddlewareOptions, IdempotencyStore } from "../src/idempotency.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function openKeyStore(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

function databaseWithClockAhead(db: Database, aheadMs: number): Database {
  const realNow = Date.now;
  const skewed = async <T>(body: () => Promise<T>): Promise<T> => {
    Date.now = () => realNow.call(Date) + aheadMs;
    try {
      return await body();
    } finally {
      Date.now = realNow;
    }
  };
  return {
    query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      return skewed(() => db.query<T>(text, params));
    },
    transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return skewed(() => db.transaction(fn));
    },
    close(): Promise<void> {
      return db.close();
    },
  };
}

async function remainingLifetimeMs(db: Database, scope: string, key: string): Promise<number> {
  const { rows } = await db.query<{ remaining_ms: string }>(
    "select extract(epoch from (expires_at - now())) * 1000 as remaining_ms from idempotency_keys where scope = $1 and key = $2",
    [scope, key]
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no idempotency row for ${scope}/${key}`);
  return Number(row.remaining_ms);
}

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

  it("refuses a Map body rather than giving two different payouts the same hash", () => {
    const alice = { method: "POST", path: "/payouts", actor: "0xabc", body: new Map<string, unknown>([["amount", 1], ["to", "0xalice"]]) };
    const mallory = { method: "POST", path: "/payouts", actor: "0xabc", body: new Map<string, unknown>([["amount", 1_000_000], ["to", "0xmallory"]]) };

    expect(() => hashRequest(alice)).toThrow(TypeError);
    expect(() => hashRequest(mallory)).toThrow(TypeError);

    const asObjects = [alice, mallory].map((request) =>
      hashRequest({ ...request, body: Object.fromEntries(request.body) })
    );
    expect(asObjects[0]).not.toBe(asObjects[1]);
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
  const hash = "ab".repeat(32);
  const otherHash = "cd".repeat(32);

  it("stores a claim and replays it, and never overwrites a live row", async () => {
    const db = await openKeyStore();
    try {
      const store = postgresIdempotencyStore(db);
      expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 1 } }, DAY_MS)).toEqual({
        status: "stored",
      });

      const live = await store.get("orders", "k1");
      expect(live).toMatchObject({ requestHash: hash, status: 201, body: { id: 1 } });
      expect(live?.expiresAt).toBeGreaterThan(Date.now());

      const again = await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 2 } }, DAY_MS);
      expect(again).toEqual({ status: "exists", stored: live });

      const reused = await store.putIfAbsent("orders", "k1", otherHash, { status: 201, body: { id: 3 } }, DAY_MS);
      expect(reused).toEqual({ status: "exists", stored: live });
      expect((await store.get("orders", "k1"))?.body).toEqual({ id: 1 });
    } finally {
      await db.close();
    }
  });

  it("reclaims a row whose ttl has passed and hides it from reads in the meantime", async () => {
    const db = await openKeyStore();
    try {
      const store = postgresIdempotencyStore(db);
      expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 1 } }, -1_000)).toEqual({
        status: "stored",
      });
      expect(await store.get("orders", "k1")).toBeUndefined();
      expect(await store.putIfAbsent("orders", "k1", otherHash, { status: 201, body: { id: 2 } }, DAY_MS)).toEqual({
        status: "stored",
      });
      expect(await store.get("orders", "k1")).toMatchObject({ requestHash: otherHash, body: { id: 2 } });
    } finally {
      await db.close();
    }
  });

  it("lets exactly one of two concurrent claims win, and hands the loser the winner's response", async () => {
    const db = await openKeyStore();
    try {
      const store = postgresIdempotencyStore(db);
      const results = await Promise.all([
        store.putIfAbsent("orders", "k1", hash, { status: 201, body: { claim: "first" } }, DAY_MS),
        store.putIfAbsent("orders", "k1", hash, { status: 201, body: { claim: "second" } }, DAY_MS),
      ]);
      expect(results.filter((result) => result.status === "stored")).toHaveLength(1);

      const loser = results.find((result) => result.status === "exists");
      expect(loser).toBeDefined();
      const winner = await store.get("orders", "k1");
      expect(loser).toEqual({ status: "exists", stored: winner });
      expect(winner?.body).toEqual(results[0]?.status === "stored" ? { claim: "first" } : { claim: "second" });
    } finally {
      await db.close();
    }
  });

  it.each([
    ["equal to the database", 0],
    ["25 hours behind the database", 25 * 60 * 60 * 1000],
    ["1 hour behind the database", 60 * 60 * 1000],
  ] as const)("measures the ttl on the database clock when the application clock is %s", async (_label, aheadMs) => {
    const base = await openKeyStore();
    try {
      const db = databaseWithClockAhead(base, aheadMs);
      const store = postgresIdempotencyStore(db);
      expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 1 } }, DAY_MS)).toEqual({
        status: "stored",
      });
      expect(await store.get("orders", "k1")).toMatchObject({ body: { id: 1 } });
      expect(await store.putIfAbsent("orders", "k1", hash, { status: 201, body: { id: 2 } }, DAY_MS)).toMatchObject({
        status: "exists",
      });
      expect(Math.abs((await remainingLifetimeMs(db, "orders", "k1")) - DAY_MS)).toBeLessThan(5_000);
    } finally {
      await base.close();
    }
  });

  it("runs the handler once across a full withIdempotency round trip", async () => {
    const db = await openKeyStore();
    try {
      const handler = vi.fn(async (): Promise<HandlerResponse> => ({ status: 201, body: { id: 7 } }));
      const execute = withIdempotency(postgresIdempotencyStore(db), handler);
      const input = { scope: "orders", key: "k1", requestHash: hash };
      expect(await execute(input)).toEqual({ source: "handler", status: 201, body: { id: 7 } });
      expect(await execute(input)).toEqual({ source: "replay", status: 201, body: { id: 7 } });
      expect(await execute({ ...input, requestHash: otherHash })).toEqual({
        source: "conflict",
        status: 409,
        body: { error: "idempotency_key_reused" },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });

  it("keeps each scope separate and reports an unknown key as absent", async () => {
    const db = await openKeyStore();
    try {
      const store = postgresIdempotencyStore(db);
      await store.putIfAbsent(idempotencyScope("orders", "tenant-a"), "k1", hash, { status: 201, body: null }, DAY_MS);
      expect(await store.get(idempotencyScope("orders", "tenant-a"), "k1")).toBeDefined();
      expect(await store.get(idempotencyScope("orders", "tenant-b"), "k1")).toBeUndefined();
      expect(await store.get("orders", "missing")).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("round-trips the column types the driver hands back: bytea hash, smallint status, jsonb body", async () => {
    const db = await openKeyStore();
    try {
      const store = postgresIdempotencyStore(db);
      const body = { nested: { list: [1, "two", null], flag: true } };
      await store.putIfAbsent("orders", "k1", hash, { status: 202, body }, DAY_MS);
      const stored = await store.get("orders", "k1");
      expect(stored?.requestHash).toBe(hash);
      expect(stored?.status).toBe(202);
      expect(stored?.body).toEqual(body);
      expect(Number.isFinite(stored?.expiresAt)).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe("canonicalQuery", () => {
  it("orders parameters by name and then by value, so query order cannot change the hash", () => {
    expect(canonicalQuery("?b=2&a=1")).toBe(canonicalQuery("?a=1&b=2"));
    expect(canonicalQuery("?a=2&a=1")).toBe(canonicalQuery("?a=1&a=2"));
    expect(canonicalQuery("")).toBe("");
    expect(canonicalQuery("?b=2&a=1")).toBe("a=1&b=2");
  });

  it("keeps different parameter sets apart", () => {
    expect(canonicalQuery("?a=1&b=2")).not.toBe(canonicalQuery("?a=1&b=3"));
    expect(canonicalQuery("?a=1")).not.toBe(canonicalQuery("?b=1"));
  });

  it("leaves the path alone and drops an empty query", () => {
    expect(pathWithCanonicalQuery("https://api.example/orders?b=2&a=1")).toBe("/orders?a=1&b=2");
    expect(pathWithCanonicalQuery("https://api.example/orders")).toBe("/orders");
    expect(pathWithCanonicalQuery("https://api.example/orders?")).toBe("/orders");
  });

  it("gives the same request hash whatever order the client sent the query in", () => {
    const first = hashRequest({ method: "POST", path: pathWithCanonicalQuery("https://api.example/orders?a=1&b=2") });
    const second = hashRequest({ method: "POST", path: pathWithCanonicalQuery("https://api.example/orders?b=2&a=1") });
    expect(first).toBe(second);
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

  function buildEcho(status: 201 | 422, extra: Partial<IdempotencyMiddlewareOptions> = {}) {
    const app = new Hono();
    let calls = 0;
    app.use(
      "/orders",
      idempotencyMiddleware(memoryIdempotencyStore(), {
        scope: "orders",
        actorOf: (c) => c.req.header("x-tenant"),
        ...extra,
      })
    );
    app.post("/orders", (c) => {
      calls += 1;
      return c.json({ calls }, status);
    });
    const post = (query: string, key: string) =>
      app.request(`/orders${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": "tenant-a", "idempotency-key": key },
        body: JSON.stringify({ item: "tea" }),
      });
    return { post, calls: () => calls };
  }

  it("treats the same query sent in another order as the same request", async () => {
    const { post, calls } = buildEcho(201);
    const first = await post("?a=1&b=2", "k1");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ calls: 1 });

    const reordered = await post("?b=2&a=1", "k1");
    expect(reordered.status).toBe(201);
    expect(reordered.headers.get("idempotent-replayed")).toBe("true");
    expect(await reordered.json()).toEqual({ calls: 1 });
    expect(calls()).toBe(1);

    const different = await post("?a=1&b=3", "k1");
    expect(different.status).toBe(409);
    expect(await different.json()).toEqual({ error: "idempotency_key_reused" });
  });

  it("stores a 4xx under the default policy, so the key replays it", async () => {
    const { post, calls } = buildEcho(422);
    expect((await post("", "k1")).status).toBe(422);
    const replay = await post("", "k1");
    expect(replay.status).toBe(422);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(calls()).toBe(1);
  });

  it("passes shouldStore through, so a policy that refuses a 4xx leaves the key free", async () => {
    const { post, calls } = buildEcho(422, { shouldStore: (response) => response.status < 400 });
    expect((await post("", "k1")).status).toBe(422);
    const retry = await post("", "k1");
    expect(retry.status).toBe(422);
    expect(retry.headers.get("idempotent-replayed")).toBeNull();
    expect(calls()).toBe(2);
  });

  it("ignores safe methods even when they carry a key", async () => {
    const { app } = build(memoryIdempotencyStore());
    const first = await app.request("/orders", { headers: { "idempotency-key": "k1" } });
    const second = await app.request("/orders", { headers: { "idempotency-key": "k1" } });
    expect(first.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
  });
});
