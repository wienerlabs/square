import { describe, it, expect, vi } from "vitest";
import { AgentUriError, defaultFetchAgentUri } from "../src/fetch.js";

/**
 * The dereferencer, with fetch injected so that redirects, bodies and
 * timeouts are scripted rather than served. What is under test is the policy:
 * which URLs are contacted at all, in which order, and how a failure is
 * described to a stranger.
 */

const CARD = { name: "Scribe", services: [] };

type Step = { status?: number; headers?: Record<string, string>; body?: string | Uint8Array[] };

/** A fetch that answers each call with the next step, and remembers the URLs it was asked for. */
function scripted(steps: Step[]) {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(input));
    expect(init?.redirect).toBe("manual");
    const step = steps[urls.length - 1] ?? { status: 200, body: JSON.stringify(CARD) };
    const body =
      step.body === undefined
        ? null
        : typeof step.body === "string"
          ? step.body
          : new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of step.body as Uint8Array[]) controller.enqueue(chunk);
                controller.close();
              },
            });
    return new Response(body, { status: step.status ?? 200, headers: step.headers ?? {} });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
}

async function failure(promise: Promise<unknown>): Promise<AgentUriError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentUriError);
    return err as AgentUriError;
  }
  return expect.unreachable("expected the fetch to fail") as never;
}

describe("schemes", () => {
  it("refuses http outright, without contacting anything", async () => {
    const { fetch, urls } = scripted([]);
    const err = await failure(defaultFetchAgentUri("http://cards.example/a.json", { fetch }));
    expect(err.code).toBe("unsupportedScheme");
    expect(urls).toEqual([]);
  });

  it("fetches https", async () => {
    const { fetch, urls } = scripted([]);
    expect(await defaultFetchAgentUri("https://cards.example/a.json", { fetch })).toEqual(CARD);
    expect(urls).toEqual(["https://cards.example/a.json"]);
  });
});

describe("redirects", () => {
  it("does not follow https down to http, on any hop", async () => {
    // Node's fetch would have: mixed-content blocking is a browser policy, not
    // part of fetch. Whoever chose the agentURI could write https and 302 to
    // plain text, and the documented refusal of http would have been for show.
    const { fetch, urls } = scripted([{ status: 302, headers: { location: "http://cards.example/a.json" } }]);
    const err = await failure(defaultFetchAgentUri("https://cards.example/start", { fetch }));
    expect(err.code).toBe("unsupportedScheme");
    expect(urls).toEqual(["https://cards.example/start"]);
  });

  it("follows https to https, resolving a relative location against the hop it came from", async () => {
    const { fetch, urls } = scripted([
      { status: 301, headers: { location: "/moved/a.json" } },
      { status: 307, headers: { location: "https://cdn.example/a.json" } },
    ]);
    expect(await defaultFetchAgentUri("https://cards.example/start", { fetch })).toEqual(CARD);
    expect(urls).toEqual([
      "https://cards.example/start",
      "https://cards.example/moved/a.json",
      "https://cdn.example/a.json",
    ]);
  });

  it("holds every hop to the host allowlist", async () => {
    const { fetch, urls } = scripted([{ status: 302, headers: { location: "https://elsewhere.example/a.json" } }]);
    const err = await failure(
      defaultFetchAgentUri("https://cards.example/start", { fetch, allowedHosts: ["cards.example"] }),
    );
    expect(err.code).toBe("hostNotAllowed");
    expect(urls).toEqual(["https://cards.example/start"]);
  });

  it("refuses a hop into a private address", async () => {
    const { fetch, urls } = scripted([{ status: 302, headers: { location: "https://10.0.0.5/admin" } }]);
    const err = await failure(defaultFetchAgentUri("https://cards.example/start", { fetch }));
    expect(err.code).toBe("hostNotPublic");
    expect(urls).toHaveLength(1);
  });

  it("gives up after five redirects", async () => {
    const { fetch, urls } = scripted(
      Array.from({ length: 7 }, (_, i) => ({ status: 302, headers: { location: `https://cards.example/${i}` } })),
    );
    const err = await failure(defaultFetchAgentUri("https://cards.example/start", { fetch }));
    expect(err.code).toBe("tooManyRedirects");
    expect(urls).toHaveLength(6);
  });

  it("treats a redirect without a location as a failure, not as a document", async () => {
    const { fetch } = scripted([{ status: 302 }]);
    expect((await failure(defaultFetchAgentUri("https://cards.example/a", { fetch }))).code).toBe("redirectWithoutLocation");
  });
});

describe("hosts", () => {
  const refused = [
    "https://127.0.0.1/",
    "https://127.1/", // short form; the URL parser canonicalises it to 127.0.0.1
    "https://0177.0.0.1/", // octal
    "https://0x7f.0.0.1/", // hex
    "https://2130706433/", // decimal
    "https://0.0.0.0/",
    "https://10.0.0.5/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/", // CGNAT
    "https://localhost/",
    "https://api.localhost/",
    "https://localhost./",
    "https://[::1]/",
    "https://[::]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.5]/",
    "https://[64:ff9b::7f00:1]/", // NAT64 of 127.0.0.1
    "https://[2002:7f00:1::]/", // 6to4 of 127.0.0.1
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[ff02::1]/",
  ];

  it.each(refused)("refuses %s before connecting", async (uri) => {
    const { fetch, urls } = scripted([]);
    const err = await failure(defaultFetchAgentUri(uri, { fetch }));
    expect(err.code).toBe("hostNotPublic");
    expect(urls).toEqual([]);
  });

  it.each(["https://1.1.1.1/a.json", "https://[2606:4700::1111]/a.json", "https://cards.example/a.json"])(
    "contacts %s",
    async (uri) => {
      const { fetch, urls } = scripted([]);
      await defaultFetchAgentUri(uri, { fetch });
      expect(urls).toHaveLength(1);
    },
  );

  it("refuses credentials in the URL", async () => {
    const { fetch } = scripted([]);
    expect((await failure(defaultFetchAgentUri("https://user:pw@cards.example/a", { fetch }))).code).toBe("credentialsInUrl");
  });

  it("applies the allowlist case-insensitively and to the first hop", async () => {
    const { fetch, urls } = scripted([]);
    await defaultFetchAgentUri("https://Cards.Example/a.json", { fetch, allowedHosts: ["cards.example"] });
    expect(urls).toHaveLength(1);
    const err = await failure(defaultFetchAgentUri("https://other.example/a.json", { fetch, allowedHosts: ["cards.example"] }));
    expect(err.code).toBe("hostNotAllowed");
  });
});

describe("bodies", () => {
  it("refuses a declared length over the cap without reading the body", async () => {
    const { fetch } = scripted([{ status: 200, headers: { "content-length": "2000000" }, body: "{}" }]);
    const err = await failure(defaultFetchAgentUri("https://cards.example/a", { fetch }));
    expect(err.code).toBe("tooLarge");
  });

  it("cuts a streamed body at the cap", async () => {
    // The timeout bounds seconds, not bytes; a fast host can send a great deal
    // in ten seconds, and res.json() would have held all of it.
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const { fetch } = scripted([{ status: 200, body: Array.from({ length: 64 }, () => chunk) }]);
    const err = await failure(defaultFetchAgentUri("https://cards.example/a", { fetch, maxResponseBytes: 16 * 1024 }));
    expect(err.code).toBe("tooLarge");
  });

  it("reads a body under the cap, in chunks", async () => {
    const text = JSON.stringify(CARD);
    const bytes = new TextEncoder().encode(text);
    const { fetch } = scripted([{ status: 200, body: [bytes.slice(0, 5), bytes.slice(5)] }]);
    expect(await defaultFetchAgentUri("https://cards.example/a", { fetch, maxResponseBytes: bytes.byteLength })).toEqual(CARD);
  });

  it("names a non-JSON body as such", async () => {
    const { fetch } = scripted([{ status: 200, body: "<html>not a card</html>" }]);
    expect((await failure(defaultFetchAgentUri("https://cards.example/a", { fetch }))).code).toBe("notJson");
  });

  it("keeps the HTTP status off the message and on the error", async () => {
    // The message becomes a warning that goes back to whoever asked, and the
    // URI was chosen by whoever registered the agent. Status and URL in it
    // would make every resolution a probe of the resolver's network.
    const { fetch } = scripted([{ status: 403, body: "no" }]);
    const err = await failure(defaultFetchAgentUri("https://cards.example/a", { fetch }));
    expect(err.code).toBe("httpError");
    expect(err.status).toBe(403);
    expect(err.message).not.toMatch(/403|cards\.example/);
  });

  it("keeps the network stack's words off the message and in detail", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND cards.example") });
    }) as unknown as typeof globalThis.fetch;
    const err = await failure(defaultFetchAgentUri("https://cards.example/a", { fetch }));
    expect(err.code).toBe("unreachable");
    expect(err.message).not.toMatch(/ENOTFOUND|cards\.example/);
    expect(err.detail).toMatch(/ENOTFOUND/);
  });

  it("reports a timeout as a timeout", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof globalThis.fetch;
    const err = await failure(defaultFetchAgentUri("https://cards.example/a", { fetch, timeoutMs: 5 }));
    expect(err.code).toBe("timeout");
  });
});

describe("ipfs", () => {
  it("appends a CID to the gateway, with or without the legacy ipfs/ prefix, with a path", async () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    for (const [uri, expected] of [
      [`ipfs://${cid}`, `https://ipfs.io/ipfs/${cid}`],
      [`ipfs://ipfs/${cid}`, `https://ipfs.io/ipfs/${cid}`],
      [`ipfs://${cid}/agent.json`, `https://ipfs.io/ipfs/${cid}/agent.json`],
      ["ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
    ] as const) {
      const { fetch, urls } = scripted([]);
      await defaultFetchAgentUri(uri, { fetch });
      expect(urls, uri).toEqual([expected]);
    }
  });

  it.each([
    "ipfs://../../admin",
    "ipfs://x/../../../../metrics",
    "ipfs://..%2F..%2Fadmin",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/%2e%2e/x",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/../x",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/a?b=c",
    "ipfs://",
    "ipfs://cid.with.dots",
  ])("does not let %s leave the gateway's path", async (uri) => {
    // On ipfs.io this walks to some other public page. On an operator's own
    // gateway, the one --ipfs-gateway exists for, it reaches whatever else that
    // host serves.
    const { fetch, urls } = scripted([]);
    const err = await failure(defaultFetchAgentUri(uri, { fetch, ipfsGateway: "https://gw.internal.example/ipfs/" }));
    expect(err.code).toBe("malformedUri");
    expect(urls).toEqual([]);
  });

  it("reads through a local node over plain http, and follows its subdomain redirect on loopback", async () => {
    // Kubo answers /ipfs/<cid> on localhost with a redirect to
    // <cid>.ipfs.localhost. A card has to be readable through a local node
    // before anything is deployed; that is the one place http is tolerated.
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const { fetch, urls } = scripted([{ status: 301, headers: { location: `http://${cid}.ipfs.localhost:8080/` } }]);
    expect(await defaultFetchAgentUri(`ipfs://${cid}`, { fetch, ipfsGateway: "http://127.0.0.1:8080/ipfs/" })).toEqual(CARD);
    expect(urls).toEqual([`http://127.0.0.1:8080/ipfs/${cid}`, `http://${cid}.ipfs.localhost:8080/`]);
  });

  it("refuses a plain-http gateway that is not on loopback", async () => {
    const { fetch, urls } = scripted([]);
    const err = await failure(
      defaultFetchAgentUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", { fetch, ipfsGateway: "http://gw.example/ipfs/" }),
    );
    expect(err.code).toBe("unsupportedScheme");
    expect(urls).toEqual([]);
  });

  it("checks where a public gateway redirects to like any other hop", async () => {
    const { fetch, urls } = scripted([{ status: 302, headers: { location: "http://127.0.0.1:5001/api/v0/shutdown" } }]);
    const err = await failure(defaultFetchAgentUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", { fetch }));
    expect(err.code).toBe("unsupportedScheme");
    expect(urls).toHaveLength(1);
  });

  it("exempts the configured gateway from the allowlist, not its redirects", async () => {
    const { fetch, urls } = scripted([{ status: 302, headers: { location: "https://elsewhere.example/x" } }]);
    const err = await failure(
      defaultFetchAgentUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", { fetch, allowedHosts: ["cards.example"] }),
    );
    expect(urls).toEqual(["https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]);
    expect(err.code).toBe("hostNotAllowed");
  });
});

describe("data", () => {
  const b64 = (v: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(v)).toString("base64")}`;

  it("decodes base64 and percent-encoded payloads in-process", async () => {
    const { fetch, urls } = scripted([]);
    expect(await defaultFetchAgentUri(b64(CARD), { fetch })).toEqual(CARD);
    expect(await defaultFetchAgentUri(`data:application/json,${encodeURIComponent(JSON.stringify(CARD))}`, { fetch })).toEqual(CARD);
    expect(urls).toEqual([]);
  });

  it("wraps a malformed payload as an AgentUriError, so callers can tell it from a driver fault", async () => {
    // decodeURIComponent and JSON.parse used to throw raw URIError and
    // SyntaxError out of the data: branch. resolve() keys its warning code on
    // the class, and the CLI keys its --no-card-check hint on it too.
    expect((await failure(defaultFetchAgentUri("data:application/json,%E0%A4%A"))).code).toBe("malformedUri");
    expect((await failure(defaultFetchAgentUri("data:application/json;base64,@@@@"))).code).toBe("malformedUri");
    expect((await failure(defaultFetchAgentUri("data:application/json,{not json"))).code).toBe("notJson");
    expect((await failure(defaultFetchAgentUri("data:application/json"))).code).toBe("malformedUri");
  });

  it("holds a data: payload to the same byte cap", async () => {
    const err = await failure(defaultFetchAgentUri(b64({ pad: "x".repeat(100) }), { maxResponseBytes: 50 }));
    expect(err.code).toBe("tooLarge");
  });
});
