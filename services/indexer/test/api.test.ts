import { describe, it, expect } from "vitest";
import {
  claimListings,
  disputes,
  jobs,
  migrate,
  MIGRATIONS_DIR,
  pgliteDatabase,
  type Database,
} from "@squaresdk/data";
import { createHealth, createMetrics } from "@squaresdk/observability";
import { createApi, readPage, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../src/api.js";
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

const CLIENT = "0x1111111111111111111111111111111111111111" as const;
const PROVIDER = "0x2222222222222222222222222222222222222222" as const;
const EVALUATOR = "0x3333333333333333333333333333333333333333" as const;
const NOW = BigInt(Math.floor(Date.now() / 1000));

interface Page {
  items: Array<{ jobId: string }>;
  nextAfter: string | null;
}

function openJob(jobId: bigint): jobs.JobRecord {
  return {
    chainId: CHAIN,
    jobId,
    client: CLIENT,
    provider: PROVIDER,
    evaluator: EVALUATOR,
    hook: null,
    description: "translate a document",
    budget: 25_000_000n,
    status: jobs.JOB_STATUS.open,
    expiredAt: NOW + 86_400n,
    createdAt: NOW - 3_600n,
    fundedAt: null,
    submittedAt: null,
    challengeEnd: null,
    platformFeeBp: 250,
    evaluatorFeeBp: 100,
    deliverable: null,
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: null,
    updatedBlock: 1_000n,
    refundReason: null,
  };
}

function submittedJob(jobId: bigint, challengeEnd: bigint): jobs.JobRecord {
  return {
    ...openJob(jobId),
    status: jobs.JOB_STATUS.submitted,
    fundedAt: NOW - 3_000n,
    submittedAt: NOW - 600n,
    challengeEnd,
  };
}

async function migratedDatabase(): Promise<Database> {
  const database = await pgliteDatabase();
  await migrate(database, MIGRATIONS_DIR, "up");
  return database;
}

function apiOver(database: Database) {
  return createApi({
    db: database,
    chainId: CHAIN,
    indexer,
    health: createHealth({ service: "square-indexer", version: "0" }),
    metrics: createMetrics({ service: "square-indexer", defaultMetrics: false }),
  });
}

async function readPageAt(app: ReturnType<typeof apiOver>, path: string): Promise<Page> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

async function walk(app: ReturnType<typeof apiOver>, path: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let after: string | null = null;
  for (let step = 0; step < 20; step += 1) {
    const body = await readPageAt(app, `${path}?limit=${limit}${after === null ? "" : `&after=${after}`}`);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    seen.push(...body.items.map((row) => row.jobId));
    if (body.nextAfter === null) return seen;
    after = body.nextAfter;
  }
  throw new Error("the cursor never reached the end of the list");
}

describe("reading a page of a list", () => {
  it("defaults to a hundred rows and caps what a caller may ask for", () => {
    expect(readPage(undefined, undefined)).toEqual({ limit: DEFAULT_PAGE_LIMIT });
    expect(readPage("25", undefined)).toEqual({ limit: 25 });
    expect(readPage(String(MAX_PAGE_LIMIT + 1), undefined)).toEqual({ limit: MAX_PAGE_LIMIT });
    expect(readPage("100000", undefined)).toEqual({ limit: MAX_PAGE_LIMIT });
    expect(readPage("10", "7")).toEqual({ limit: 10, after: 7n });
  });

  it("refuses a limit or a cursor that is not a whole number", () => {
    expect(readPage("0", undefined)).toEqual({ error: "not a limit" });
    expect(readPage("-1", undefined)).toEqual({ error: "not a limit" });
    expect(readPage("1.5", undefined)).toEqual({ error: "not a limit" });
    expect(readPage("all", undefined)).toEqual({ error: "not a limit" });
    expect(readPage("", undefined)).toEqual({ error: "not a limit" });
    expect(readPage(undefined, "0x1")).toEqual({ error: "not a job id" });
    expect(readPage(undefined, "-3")).toEqual({ error: "not a job id" });
  });
});

describe("a list endpoint never answers with the whole table", () => {
  it("bounds a table larger than the default and hands back the cursor for the rest", async () => {
    const db = await migratedDatabase();
    try {
      await db.transaction(async (tx) => {
        for (let id = 1; id <= DEFAULT_PAGE_LIMIT + 1; id += 1) await jobs.upsert(tx, openJob(BigInt(id)));
      });
      const app = apiOver(db);

      const first = await readPageAt(app, "/jobs/open");
      expect(first.items).toHaveLength(DEFAULT_PAGE_LIMIT);
      expect(first.items[0]?.jobId).toBe("1");
      expect(first.nextAfter).toBe(String(DEFAULT_PAGE_LIMIT));

      const rest = await readPageAt(app, `/jobs/open?after=${DEFAULT_PAGE_LIMIT}`);
      expect(rest.items.map((row) => row.jobId)).toEqual([String(DEFAULT_PAGE_LIMIT + 1)]);
      expect(rest.nextAfter).toBe(null);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("takes a limit and walks every row of a list exactly once", async () => {
    const db = await migratedDatabase();
    try {
      const ids = [1n, 2n, 3n, 4n, 5n, 6n, 7n];
      const wanted = ids.map((id) => id.toString());
      await db.transaction(async (tx) => {
        for (const id of ids) {
          await jobs.upsert(tx, openJob(id));
          await claimListings.upsert(tx, {
            chainId: CHAIN,
            jobId: id,
            seller: PROVIDER,
            buyer: null,
            price: 9_000_000n,
            faceValue: 10_000_000n,
            status: claimListings.CLAIM_LISTING_STATUS.listed,
            updatedBlock: 1_000n,
          });
          await disputes.upsert(tx, {
            chainId: CHAIN,
            jobId: id,
            disputer: CLIENT,
            bond: 5_000_000n,
            disputedAt: NOW,
            resolveBy: NOW + (8n - id) * 100n,
            setVersion: 1,
            outcome: null,
            providerBps: null,
            closed: false,
            updatedBlock: 1_000n,
          });
        }
      });
      const app = apiOver(db);

      const first = await readPageAt(app, "/jobs/open?limit=3");
      expect(first.items.map((row) => row.jobId)).toEqual(["1", "2", "3"]);
      expect(first.nextAfter).toBe("3");

      expect(await walk(app, "/jobs/open", 3)).toEqual(wanted);
      expect(await walk(app, `/jobs/provider/${PROVIDER}`, 2)).toEqual(wanted);
      expect(await walk(app, "/listings", 4)).toEqual(wanted);
      expect(await walk(app, "/disputes/open", 2)).toEqual(wanted);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("walks the challenge window lists whose rows a job id cursor could otherwise skip", async () => {
    const db = await migratedDatabase();
    try {
      await db.transaction(async (tx) => {
        for (const id of [1n, 2n, 3n, 4n]) await jobs.upsert(tx, submittedJob(id, NOW + (5n - id) * 600n));
        for (const id of [5n, 6n, 7n]) await jobs.upsert(tx, submittedJob(id, NOW - (8n - id) * 600n));
      });
      const app = apiOver(db);

      expect(await walk(app, "/jobs/in-window", 2)).toEqual(["1", "2", "3", "4"]);
      expect(await walk(app, "/jobs/finalizable", 2)).toEqual(["5", "6", "7"]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("answers 400 for a limit or a cursor it cannot read, on every list", async () => {
    const db = await migratedDatabase();
    try {
      const app = apiOver(db);

      for (const path of ["/jobs/open", "/jobs/in-window", "/jobs/finalizable", `/jobs/provider/${PROVIDER}`, "/listings", "/disputes/open"]) {
        expect((await app.request(`${path}?limit=none`)).status).toBe(400);
        expect((await app.request(`${path}?after=none`)).status).toBe(400);
        expect((await app.request(path)).status).toBe(200);
      }
      expect((await app.request("/jobs/provider/not-an-address?limit=1")).status).toBe(400);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("counts the overview so the app polls numbers instead of rows", async () => {
    const db = await migratedDatabase();
    try {
      await db.transaction(async (tx) => {
        for (const id of [1n, 2n, 3n]) await jobs.upsert(tx, openJob(id));
        for (const id of [4n, 5n]) await jobs.upsert(tx, submittedJob(id, NOW + 600n));
        await jobs.upsert(tx, submittedJob(6n, NOW - 600n));
      });
      const app = apiOver(db);

      const response = await app.request("/overview");
      const body = (await response.json()) as { chainId: number; counts: { open: number; inWindow: number; finalizable: number } };

      expect(response.status).toBe(200);
      expect(body.chainId).toBe(CHAIN);
      expect(body.counts).toEqual({ open: 3, inWindow: 2, finalizable: 1 });
      expect(Object.keys(body).sort()).toEqual(
        ["chainHead", "chainId", "counts", "jobs", "lastIndexedBlock", "missingWindowEvents", "quarantined", "windows"],
      );
    } finally {
      await db.close();
    }
  }, 30_000);
});
