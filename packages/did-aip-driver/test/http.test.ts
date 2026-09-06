import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import type { DidResolutionResult } from "@squaresdk/did-resolver";

/**
 * The HTTP surface, driven end to end over a real socket with a stub resolver.
 * The hermetic smoke check the v1 driver had — a malformed DID must answer 400 —
 * lives here and is the one assertion that must never regress.
 */
const CONFIG = { port: 0, rpc: { 5042002: "http://stub" }, allowedRegistries: undefined, timeoutMs: 1000 };

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
