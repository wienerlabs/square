import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import type { DidResolutionResult } from "@squaresdk/did-resolver";

/**
 * The HTTP surface, driven end to end over a real socket with a stub resolver.
 * The hermetic smoke check the v1 driver had — a malformed DID must answer 400 —
 * lives here and is the one assertion that must never regress.
 */
const CONFIG = {
  port: 0,
  rpc: { 5042002: "http://stub" },
  allowedRegistries: undefined,
  allowedAgentUriHosts: undefined,
  timeoutMs: 1000,
};

function serveWith(resolve: (did: string) => Promise<DidResolutionResult>) {
  const app = createApp(CONFIG, { resolve } as never);
  return new Promise<{ server: Server; url: string }>((res) => {
    const server = createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const okFor = (did: string): DidResolutionResult => ({
  didDocument: { id: did } as never,
  didResolutionMetadata: { contentType: "application/did+ld+json" },
  didDocumentMetadata: { versionId: "1" },
});
const failWith = (error: string): DidResolutionResult => ({
  didDocument: null,
  didResolutionMetadata: { error: error as never, errorMessage: "…" },
  didDocumentMetadata: {},
});

describe("driver HTTP", () => {
  it("answers /health", async () => {
    const { server, url } = await serveWith(async (d) => okFor(d));
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).chains).toEqual([5042002]);
    server.close();
  });

  it("returns 400 for a malformed DID", async () => {
    // The hermetic smoke check, carried over from the v1 driver.
    const { server, url } = await serveWith(async () => failWith("invalidDid"));
    const r = await fetch(`${url}/1.0/identifiers/did:aip:nonsense`);
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("application/did+ld+json");
    expect((await r.json()).didDocument).toBeNull();
    server.close();
  });

  it("passes a v2 DID through whole, colons and all", async () => {
    // Express would stop at the first colon without the greedy pattern, and the
    // resolver would then reject a DID that was never malformed.
    const did = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2";
    let seen = "";
    const { server, url } = await serveWith(async (d) => { seen = d; return okFor(d); });
    const r = await fetch(`${url}/1.0/identifiers/${encodeURIComponent(did)}`);
    expect(r.status).toBe(200);
    expect(seen).toBe(did);
    expect((await r.json()).didDocument.id).toBe(did);
    server.close();
  });

  it("passes an unencoded DID through too", async () => {
    const did = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2";
    let seen = "";
    const { server, url } = await serveWith(async (d) => { seen = d; return okFor(d); });
    await fetch(`${url}/1.0/identifiers/${did}`);
    expect(seen).toBe(did);
    server.close();
  });

  it("decodes the identifier exactly once, so a percent-encoded colon stays a percent-encoded colon", async () => {
    // Express decodes params itself. A second decodeURIComponent turned
    // `%253A` into `:`, which added a segment: two request paths named the same
    // DID, and the resolver saw a DID the client had not asked for. Segment
    // count is what decides v1 from v2, so that is not a cosmetic difference.
    let seen = "";
    const { server, url } = await serveWith(async (d) => { seen = d; return failWith("invalidDid"); });
    await fetch(`${url}/1.0/identifiers/did:aip:x%253Ay`);
    expect(seen).toBe("did:aip:x%3Ay");
    server.close();
  });

  it("answers %25 with a 400 envelope from the resolver, and stays up", async () => {
    // `%25` decodes to `%` once, which is what Express does. The second
    // decodeURIComponent the route used to run turned that `%` into a URIError
    // outside the try, in an async handler: an unhandled rejection, and the
    // process exited. Three characters took the driver down and the client got
    // no response at all. The real resolver is used here on purpose: `%` fails
    // to parse before any RPC is touched, so no network is needed to show the
    // whole path answering.
    const app = createApp(CONFIG);
    const server = createServer(app);
    await new Promise<void>((res) => server.listen(0, () => res()));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const r = await fetch(`${url}/1.0/identifiers/%25`);
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("application/did+ld+json");
    const body = await r.json();
    expect(body.didDocument).toBeNull();
    expect(body.didResolutionMetadata.error).toBe("invalidDid");
    expect((await fetch(`${url}/health`)).status).toBe(200);
    server.close();
  });

  it("keeps the RPC endpoint out of a 502 envelope", async () => {
    // viem writes the endpoint into every transport error, and on Alchemy,
    // Infura and QuickNode the endpoint carries the operator's API key in its
    // path. The envelope goes to whoever asked, and any DID on a rate-limited
    // or briefly down chain used to hand them the key (#267). Port 1 is
    // closed, so the chain id check fails before any other read, with the
    // error viem builds for exactly that case; the real resolver is used so
    // the whole path is what is measured.
    const secret = "http://127.0.0.1:1/v2/SUPER-SECRET-ALCHEMY-KEY-abc123";
    const app = createApp({ ...CONFIG, rpc: { 5042002: secret } });
    const server = createServer(app);
    await new Promise<void>((res) => server.listen(0, () => res()));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const r = await fetch(`${url}/1.0/identifiers/did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:1`);
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toContain("SUPER-SECRET");
    expect(text).not.toContain("127.0.0.1:1");
    expect(JSON.parse(text).didResolutionMetadata).toMatchObject({ error: "networkError", errorMessage: "chain id check failed" });
    server.close();
  });

  it("answers a path Express itself cannot decode with a 400 envelope, not an HTML page", async () => {
    // A lone `%` is not valid percent-encoding, so Express's own parameter
    // decoding fails before the route runs. That error carries status 400 and
    // used to fall through to the default handler's HTML. The error handler
    // maps it to invalidDid in the envelope, and the process is still here
    // afterwards. (An unhandled rejection inside this run would also fail the
    // suite by itself.)
    const { server, url } = await serveWith(async (d) => okFor(d));
    const r = await fetch(`${url}/1.0/identifiers/%`);
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("application/did+ld+json");
    const body = await r.json();
    expect(body.didDocument).toBeNull();
    expect(body.didResolutionMetadata.error).toBe("invalidDid");
    expect((await fetch(`${url}/health`)).status).toBe(200);
    server.close();
  });

  it("maps a v1 DID to 501, not 400", async () => {
    const { server, url } = await serveWith(async () => failWith("unsupportedVersion"));
    const r = await fetch(`${url}/1.0/identifiers/did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:scribe`);
    expect(r.status).toBe(501);
    server.close();
  });

  it("returns 500 with a body if the resolver throws", async () => {
    const { server, url } = await serveWith(async () => { throw new Error("boom"); });
    const r = await fetch(`${url}/1.0/identifiers/did:aip:eip155:1:0xaa:1`);
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.didResolutionMetadata.error).toBe("internalError");
    server.close();
  });
});
