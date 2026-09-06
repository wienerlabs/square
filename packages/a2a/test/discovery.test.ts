import { describe, it, expect } from "vitest";
import { EndpointError, WellKnownCache, findA2AEndpoint, wellKnownUrlFor } from "../src/discovery.js";

describe("findA2AEndpoint", () => {
  it("picks the A2A service out of a card", () => {
    expect(
      findA2AEndpoint({
        services: [
          { name: "MCP", endpoint: "https://a.example/mcp" },
          { name: "A2A", endpoint: "https://a.example/a2a" },
        ],
      }),
    ).toBe("https://a.example/a2a");
  });

  it("matches the name case-insensitively and ignores surrounding space", () => {
    // ERC-8004 leaves `name` free-form, so "a2a" and " A2A " are the same claim.
    expect(findA2AEndpoint({ services: [{ name: " a2a ", endpoint: "https://a.example/x" }] }))
      .toBe("https://a.example/x");
  });

  it("takes the first when a card lists several", () => {
    // Choosing by any quality heuristic would make dispatch depend on whichever
    // one we happened to prefer today.
    expect(
      findA2AEndpoint({
        services: [
          { name: "A2A", endpoint: "https://first.example/a2a" },
          { name: "A2A", endpoint: "https://second.example/a2a" },
        ],
      }),
    ).toBe("https://first.example/a2a");
  });

  it("says so when there is no A2A service", () => {
    expect(() => findA2AEndpoint({ services: [{ name: "MCP", endpoint: "https://a.example/mcp" }] }))
      .toThrow(/no A2A service/);
    expect(() => findA2AEndpoint({ services: [] })).toThrow(/no A2A service/);
    expect(() => findA2AEndpoint({})).toThrow(/no A2A service/);
  });

  it("rejects an A2A entry with no endpoint", () => {
    expect(() => findA2AEndpoint({ services: [{ name: "A2A" }] })).toThrow(/no endpoint/);
  });

  it("refuses plain http off the loopback", () => {
    // The request carries the work and a job id, and the response is what the
    // caller acts on. Both are rewritable over http.
    expect(() => findA2AEndpoint({ services: [{ name: "A2A", endpoint: "http://agent.example/a2a" }] }))
      .toThrow(EndpointError);
  });

  it("allows http on loopback, because agents are written on localhost first", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(findA2AEndpoint({ services: [{ name: "A2A", endpoint: `http://${host}:4001/a2a` }] }))
        .toBe(`http://${host}:4001/a2a`);
    }
  });

  it("refuses schemes that are not http at all", () => {
    for (const endpoint of ["javascript:alert(1)", "data:text/plain,x", "file:///etc/passwd", "ftp://a.example"]) {
      expect(() => findA2AEndpoint({ services: [{ name: "A2A", endpoint }] })).toThrow(EndpointError);
    }
  });

  it("refuses something that is not a URL", () => {
    expect(() => findA2AEndpoint({ services: [{ name: "A2A", endpoint: "not a url" }] }))
      .toThrow(/not a URL/);
  });
});

describe("wellKnownUrlFor", () => {
  it("uses ERC-8004's registration filename on the endpoint's origin", () => {
    expect(wellKnownUrlFor("https://a.example/deep/path/a2a"))
      .toBe("https://a.example/.well-known/agent-registration.json");
  });

  it("keeps a non-default port", () => {
    expect(wellKnownUrlFor("http://127.0.0.1:4001/a2a"))
      .toBe("http://127.0.0.1:4001/.well-known/agent-registration.json");
  });
});

describe("WellKnownCache", () => {
  const card = { services: [{ name: "A2A", endpoint: "https://a.example/a2a" }] };

  function cacheWith(responder: () => Promise<Response>, now = () => 0) {
    let calls = 0;
    const cache = new WellKnownCache({
      now,
      fetch: async () => { calls += 1; return responder(); },
    });
    return { cache, calls: () => calls };
  }

  it("fetches once and serves the rest from memory", async () => {
    const { cache, calls } = cacheWith(async () => new Response(JSON.stringify(card), { status: 200 }));
    expect(await cache.get("https://a.example/a2a")).toEqual(card);
    expect(await cache.get("https://a.example/a2a")).toEqual(card);
    expect(calls()).toBe(1);
  });

  it("de-duplicates concurrent misses into one request", async () => {
    const { cache, calls } = cacheWith(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify(card), { status: 200 });
    });
    await Promise.all([cache.get("https://a.example/a2a"), cache.get("https://a.example/a2a")]);
    expect(calls()).toBe(1);
  });

  it("caches a miss, so a dead endpoint is not re-fetched on every dispatch", async () => {
    const { cache, calls } = cacheWith(async () => new Response("", { status: 503 }));
    expect(await cache.get("https://down.example/a2a")).toBeNull();
    expect(await cache.get("https://down.example/a2a")).toBeNull();
    expect(calls()).toBe(1);
  });

  it("caches a miss when the fetch throws", async () => {
    const { cache, calls } = cacheWith(async () => { throw new Error("ECONNREFUSED"); });
    expect(await cache.get("https://down.example/a2a")).toBeNull();
    expect(calls()).toBe(1);
  });

  it("treats a body that is not a JSON object as a miss", async () => {
    for (const body of ["[]", '"a string"', "null"]) {
      const { cache } = cacheWith(async () => new Response(body, { status: 200 }));
      expect(await cache.get("https://a.example/a2a")).toBeNull();
    }
  });

  it("refetches once the entry is stale", async () => {
    let now = 0;
    const { cache, calls } = cacheWith(
      async () => new Response(JSON.stringify(card), { status: 200 }),
      () => now,
    );
    await cache.get("https://a.example/a2a");
    now = 5 * 60_000 + 1;
    await cache.get("https://a.example/a2a");
    expect(calls()).toBe(2);
  });

  it("peek never fetches", async () => {
    const { cache, calls } = cacheWith(async () => new Response(JSON.stringify(card), { status: 200 }));
    expect(cache.peek("https://a.example/a2a")).toBeUndefined();
    expect(calls()).toBe(0);
  });

  it("distinguishes a cached absence from a cache miss", async () => {
    // undefined means "ask"; null means "asked, and there is nothing there".
    const { cache } = cacheWith(async () => new Response("", { status: 404 }));
    expect(cache.peek("https://a.example/a2a")).toBeUndefined();
    await cache.get("https://a.example/a2a");
    expect(cache.peek("https://a.example/a2a")).toBeNull();
  });
});
