import { describe, it, expect } from "vitest";
import type { Database } from "@squaresdk/data";
import { createHealth, createMetrics } from "@squaresdk/observability";
import { createApi } from "../src/api.js";
import type { Indexer } from "../src/sync.js";

const CHAIN = 5042002;
const APP_ORIGIN = "https://square-wienerlabs.vercel.app";

const db = {
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async () => {
    throw new Error("the CORS surface does not open a transaction");
  },
  close: async () => {},
} as unknown as Database;

const indexer = {
  lastIndexedBlock: 60_843_449n,
  chainHead: 60_843_449n,
  state: { jobs: new Map(), windows: [] },
  missingWindowEvents: 0,
  quarantinedEvents: [],
} as unknown as Indexer;

function apiWith(corsOrigins: string[]) {
  return createApi({
    db,
    chainId: CHAIN,
    indexer,
    health: createHealth({ service: "square-indexer", version: "0" }),
    metrics: createMetrics({ service: "square-indexer", defaultMetrics: false }),
    corsOrigins,
  });
}

async function browserGet(app: ReturnType<typeof apiWith>, path: string, origin: string): Promise<Response> {
  return await app.fetch(new Request(`http://indexer.test${path}`, { headers: { accept: "application/json", origin } }));
}

describe("the browser can read the query surface", () => {
  it("carries the header on the GET answer itself for a configured origin", async () => {
    const response = await browserGet(apiWith([APP_ORIGIN]), "/status", APP_ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("vary") ?? "").toContain("Origin");
    expect(((await response.json()) as { chainId: number }).chainId).toBe(CHAIN);
  });

  it("answers an origin that is not configured without the header", async () => {
    const response = await browserGet(apiWith([APP_ORIGIN]), "/status", "https://square.example.com");

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(null);
  });

  it("allows a local app by default, so a production origin has to be given explicitly", async () => {
    const app = apiWith([]);

    expect((await browserGet(app, "/status", "http://localhost:3000")).headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect((await browserGet(app, "/status", APP_ORIGIN)).headers.get("access-control-allow-origin")).toBe(null);
  });

  it("covers the whole surface, health included", async () => {
    const app = apiWith([APP_ORIGIN]);

    for (const path of ["/status", "/health", "/version", "/quarantine"]) {
      expect((await browserGet(app, path, APP_ORIGIN)).headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    }
  });

  it("answers a preflight for the origins it allows", async () => {
    const app = apiWith([APP_ORIGIN]);
    const request = new Request("http://indexer.test/status", {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "GET" },
    });

    const response = await app.fetch(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-allow-methods") ?? "").toContain("GET");
  });
});
