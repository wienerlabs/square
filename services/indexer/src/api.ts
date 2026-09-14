import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getAddress, isAddress } from "viem";
import { claimListings, disputes, jobs, type Database, type ListPage } from "@squaresdk/data";
import type { Health, Metrics } from "@squaresdk/observability";
import { observabilityRoutes } from "@squaresdk/observability/hono";
import type { Indexer } from "./sync.js";

export interface ApiOptions {
  db: Database;
  chainId: number;
  indexer: Indexer;
  health: Health;
  metrics: Metrics;
  corsOrigins?: readonly string[];
}

const LOCALHOST_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export function allowedOrigin(origin: string, configured: readonly string[]): string | null {
  if (origin.length === 0) return null;
  if (LOCALHOST_ORIGIN.test(origin)) return origin;
  return configured.includes(origin) ? origin : null;
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}

function now(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

const WHOLE_NUMBER = /^[0-9]+$/;

export interface PageRequest {
  limit: number;
  after?: bigint | undefined;
}

export function readPage(rawLimit: string | undefined, rawAfter: string | undefined): PageRequest | { error: string } {
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== undefined) {
    if (!WHOLE_NUMBER.test(rawLimit) || Number(rawLimit) < 1) return { error: "not a limit" };
    limit = Math.min(Number(rawLimit), MAX_PAGE_LIMIT);
  }
  if (rawAfter === undefined) return { limit };
  if (!WHOLE_NUMBER.test(rawAfter)) return { error: "not a job id" };
  return { limit, after: BigInt(rawAfter) };
}

async function pageOf<T extends { jobId: bigint }>(c: Context, read: (page: ListPage) => Promise<T[]>): Promise<Response> {
  const asked = readPage(c.req.query("limit"), c.req.query("after"));
  if ("error" in asked) return c.json({ error: asked.error }, 400);
  const rows = await read({ limit: asked.limit + 1, after: asked.after });
  const items = rows.slice(0, asked.limit);
  const last = items[items.length - 1];
  const nextAfter = rows.length > asked.limit && last !== undefined ? last.jobId : null;
  return c.json(serialize({ items, nextAfter }));
}

export function createApi(options: ApiOptions): Hono {
  const { db, chainId, indexer } = options;
  const configured = options.corsOrigins ?? [];
  const app = new Hono();
  app.use("*", cors({ origin: (origin) => allowedOrigin(origin, configured), allowMethods: ["GET", "OPTIONS"], maxAge: 600 }));
  app.route("/", observabilityRoutes({ health: options.health, metrics: options.metrics }));

  const status = () => ({
    chainId,
    lastIndexedBlock: indexer.lastIndexedBlock === null ? null : indexer.lastIndexedBlock.toString(),
    chainHead: indexer.chainHead.toString(),
    jobs: indexer.state.jobs.size,
    windows: indexer.state.windows.length,
    missingWindowEvents: indexer.missingWindowEvents,
    quarantined: indexer.quarantinedEvents.length,
  });

  app.get("/status", (c) => c.json(status()));

  app.get("/overview", async (c) => {
    const at = now();
    const [open, inWindow, finalizable] = await Promise.all([
      jobs.countOpen(db, chainId),
      jobs.countInChallengeWindow(db, chainId, at),
      jobs.countFinalizable(db, chainId, at),
    ]);
    return c.json({ ...status(), counts: { open, inWindow, finalizable } });
  });

  app.get("/quarantine", (c) => c.json(serialize(indexer.quarantinedEvents)));

  app.get("/jobs/open", (c) => pageOf(c, (page) => jobs.listOpen(db, chainId, page)));
  app.get("/jobs/in-window", (c) => pageOf(c, (page) => jobs.listInChallengeWindow(db, chainId, now(), page)));
  app.get("/jobs/finalizable", (c) => pageOf(c, (page) => jobs.listFinalizable(db, chainId, now(), undefined, page)));
  app.get("/jobs/provider/:address", async (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return c.json({ error: "not an address" }, 400);
    const provider = getAddress(raw).toLowerCase() as `0x${string}`;
    return await pageOf(c, (page) => jobs.listByProvider(db, chainId, provider, page));
  });
  app.get("/jobs/:id", async (c) => {
    const raw = c.req.param("id");
    if (!WHOLE_NUMBER.test(raw)) return c.json({ error: "not a job id" }, 400);
    const job = await jobs.get(db, chainId, BigInt(raw));
    if (!job) return c.json({ error: "not found" }, 404);
    const [listing, dispute] = await Promise.all([claimListings.get(db, chainId, job.jobId), disputes.get(db, chainId, job.jobId)]);
    return c.json(serialize({ job, listing, dispute }));
  });
  app.get("/listings", (c) => pageOf(c, (page) => claimListings.listListed(db, chainId, page)));
  app.get("/disputes/open", (c) => pageOf(c, (page) => disputes.listOpen(db, chainId, page)));
  return app;
}
