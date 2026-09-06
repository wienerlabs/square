import { Hono } from "hono";
import { getAddress, isAddress } from "viem";
import { claimListings, disputes, jobs, type Database } from "@squaresdk/data";
import type { Health, Metrics } from "@squaresdk/observability";
import { observabilityRoutes } from "@squaresdk/observability/hono";
import type { Indexer } from "./sync.js";

export interface ApiOptions {
  db: Database;
  chainId: number;
  indexer: Indexer;
  health: Health;
  metrics: Metrics;
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

export function createApi(options: ApiOptions): Hono {
  const { db, chainId, indexer } = options;
  const app = new Hono();
  app.route("/", observabilityRoutes({ health: options.health, metrics: options.metrics }));

  app.get("/status", (c) =>
    c.json({
      chainId,
      lastIndexedBlock: indexer.lastIndexedBlock === null ? null : indexer.lastIndexedBlock.toString(),
      chainHead: indexer.chainHead.toString(),
      jobs: indexer.state.jobs.size,
    }),
  );

  app.get("/jobs/open", async (c) => c.json(serialize(await jobs.listOpen(db, chainId))));
  app.get("/jobs/in-window", async (c) => c.json(serialize(await jobs.listInChallengeWindow(db, chainId, now()))));
  app.get("/jobs/finalizable", async (c) => c.json(serialize(await jobs.listFinalizable(db, chainId, now()))));
  app.get("/jobs/provider/:address", async (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return c.json({ error: "not an address" }, 400);
    return c.json(serialize(await jobs.listByProvider(db, chainId, getAddress(raw).toLowerCase() as `0x${string}`)));
  });
  app.get("/jobs/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^[0-9]+$/.test(raw)) return c.json({ error: "not a job id" }, 400);
    const job = await jobs.get(db, chainId, BigInt(raw));
    if (!job) return c.json({ error: "not found" }, 404);
    const [listing, dispute] = await Promise.all([claimListings.get(db, chainId, job.jobId), disputes.get(db, chainId, job.jobId)]);
    return c.json(serialize({ job, listing, dispute }));
  });
  app.get("/listings", async (c) => c.json(serialize(await claimListings.listListed(db, chainId))));
  app.get("/disputes/open", async (c) => c.json(serialize(await disputes.listOpen(db, chainId))));
  return app;
}
