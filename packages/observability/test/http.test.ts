import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createHealth } from "../src/health.js";
import { createMetrics } from "../src/metrics.js";
import { mountObservability } from "../src/http.js";
import { observabilityRoutes } from "../src/hono.js";

function fixtures(healthy: boolean) {
  const health = createHealth({
    service: "prover",
    version: "0.1.0",
    checks: { circuit: { check: async () => ({ ok: healthy, detail: healthy ? "" : "artifacts missing" }), critical: true } },
  });
  const metrics = createMetrics({ service: "prover", defaultMetrics: false });
  metrics.setFinalizePending(2);
  return { health, metrics };
}

function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("express", () => {
  it("serves /health, /metrics and /version", async () => {
    const app = express();
    mountObservability(app, fixtures(true));
    const { server, base } = await listen(app);
    servers.push(server);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toContain("application/json");
    expect(await health.json()).toMatchObject({ status: "healthy", service: "prover", version: "0.1.0" });

    const version = await fetch(`${base}/version`);
    expect(version.status).toBe(200);
    expect(version.headers.get("content-type")).toContain("application/json");
    expect(await version.json()).toMatchObject({ service: "prover", version: "0.1.0", node: process.version });

    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const text = await metrics.text();
    expect(text).toContain("square_finalize_pending_total");
    expect(text).toMatch(/square_finalize_pending_total\{service="prover"\} 2/);
  });

  it("answers 503 when a critical check fails", async () => {
    const app = express();
    mountObservability(app, fixtures(false));
    const { server, base } = await listen(app);
    servers.push(server);
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "unhealthy" });
  });

  it("mounts under custom paths", async () => {
    const app = express();
    mountObservability(app, { ...fixtures(true), paths: { health: "/internal/healthz", metrics: "/internal/metrics" } });
    const { server, base } = await listen(app);
    servers.push(server);
    expect((await fetch(`${base}/internal/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/internal/metrics`)).status).toBe(200);
    expect((await fetch(`${base}/version`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });
});

describe("hono", () => {
  it("serves /health, /metrics and /version as a sub-app", async () => {
    const routes = observabilityRoutes(fixtures(true));

    const health = await routes.request("/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toContain("application/json");
    expect(await health.json()).toMatchObject({ status: "healthy", service: "prover" });

    const version = await routes.request("/version");
    expect(version.status).toBe(200);
    expect(version.headers.get("content-type")).toContain("application/json");
    expect(await version.json()).toMatchObject({ service: "prover", version: "0.1.0" });

    const metrics = await routes.request("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(await metrics.text()).toContain("square_finalize_pending_total");
  });

  it("composes into a parent app", async () => {
    const parent = new Hono();
    parent.route("/internal", observabilityRoutes(fixtures(false)));
    const health = await parent.request("/internal/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "unhealthy" });
    expect((await parent.request("/internal/metrics")).status).toBe(200);
    expect((await parent.request("/health")).status).toBe(404);
  });
});
