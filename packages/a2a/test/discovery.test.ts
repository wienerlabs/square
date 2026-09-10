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

  it("allows http and https on loopback, because agents are written on localhost first", () => {
    // The development exception, and the only one: loopback on either scheme.
    for (const host of ["localhost", "127.0.0.1", "[::1]", "agent.localhost"]) {
      for (const scheme of ["http", "https"]) {
        expect(findA2AEndpoint({ services: [{ name: "A2A", endpoint: `${scheme}://${host}:4001/a2a` }] }))
          .toBe(`${scheme}://${host}:4001/a2a`);
      }
    }
    // The URL parser canonicalises IPv4 spellings before the check runs, so
    // octal, hex and decimal loopback are loopback too, not a way around it.
    expect(findA2AEndpoint({ services: [{ name: "A2A", endpoint: "http://0177.0.0.1:4001/a2a" }] }))
      .toBe("http://0177.0.0.1:4001/a2a");
  });

  it("refuses a private, link-local or otherwise non-public address even over https", () => {
    // TLS says nothing about where a connection goes. https://169.254.169.254/
    // used to pass while http://169.254.169.254/ was refused, because the only
    // address check had ended up on the unencrypted path. The endpoint is the
    // other side's choice, and the well-known request goes to it unprompted.
    for (const endpoint of [
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/a2a",
      "https://172.16.0.1/a2a",
      "https://192.168.1.1/a2a",
      "https://100.64.0.1/a2a",
      "https://0.0.0.0/a2a",
      "https://[::ffff:10.0.0.5]/a2a",
      "https://[64:ff9b::a00:5]/a2a",
      "https://[2002:a00:5::]/a2a",
      "https://[fc00::1]/a2a",
      "https://[fe80::1]/a2a",
    ]) {
      expect(() => findA2AEndpoint({ services: [{ name: "A2A", endpoint }] }), endpoint).toThrow(/non-public/);
    }
  });

  it("refuses credentials in the endpoint", () => {
    expect(() => findA2AEndpoint({ services: [{ name: "A2A", endpoint: "https://user:pw@a.example/a2a" }] }))
      .toThrow(/credentials/);
  });

  it("lets a public literal address and any hostname through", () => {
    // A hostname is not resolved here: the package has no dependencies. That
    // gap is the host's to close, with a fetch built on hardening's safeFetch.
    for (const endpoint of ["https://1.1.1.1/a2a", "https://[2606:4700::1111]/a2a", "https://agent.example/a2a"]) {
      expect(findA2AEndpoint({ services: [{ name: "A2A", endpoint }] })).toBe(endpoint);
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

  function cacheWith(responder: (url: string) => Promise<Response>, now = () => 0, maxCardBytes?: number) {
    const urls: string[] = [];
    const cache = new WellKnownCache({
      now,
      ...(maxCardBytes !== undefined ? { maxCardBytes } : {}),
      fetch: async (input, init) => {
        urls.push(String(input));
        expect(init?.redirect).toBe("manual");
        return responder(String(input));
      },
    });
    return { cache, calls: () => urls.length, urls };
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

  it("follows a redirect to another https origin, and no further than three", async () => {
    const { cache, urls } = cacheWith(async (url) =>
      url.startsWith("https://a.example/")
        ? new Response(null, { status: 301, headers: { location: "https://cdn.example/card.json" } })
        : new Response(JSON.stringify(card), { status: 200 }),
    );
    expect(await cache.get("https://a.example/a2a")).toEqual(card);
    expect(urls).toEqual(["https://a.example/.well-known/agent-registration.json", "https://cdn.example/card.json"]);

    const loop = cacheWith(async (url) => new Response(null, { status: 302, headers: { location: `${url}/again` } }));
    expect(await loop.cache.get("https://b.example/a2a")).toBeNull();
    expect(loop.calls()).toBe(4);
  });

  it("does not follow the well-known request into http or into a private address", async () => {
    // The same mechanism #129 measured for the resolver, and the same runtime
    // default: fetch would have followed both. Here the redirect is not even
    // needed for the endpoint itself to be internal, which is what the
    // endpoint rule handles; this is the rule applied to where it sends us.
    for (const location of ["http://a.example/card.json", "https://10.0.0.5/card.json", "https://169.254.169.254/x"]) {
      const { cache, urls } = cacheWith(async () => new Response(null, { status: 302, headers: { location } }));
      expect(await cache.get("https://a.example/a2a")).toBeNull();
      expect(urls, location).toHaveLength(1);
    }
  });

  it("treats a card over the byte cap as a miss, whether declared or streamed", async () => {
    const declared = cacheWith(async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } }), () => 0, 1024);
    expect(await declared.cache.get("https://a.example/a2a")).toBeNull();

    const chunk = new TextEncoder().encode("x".repeat(512));
    const streamed = cacheWith(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (let i = 0; i < 8; i += 1) c.enqueue(chunk);
              c.close();
            },
          }),
          { status: 200 },
        ),
      () => 0,
      1024,
    );
    expect(await streamed.cache.get("https://a.example/a2a")).toBeNull();
  });
});
