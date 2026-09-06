import { describe, it, expect, afterEach } from "vitest";
import { createHealth } from "../src/health.js";

const ok = async () => ({ ok: true });
const failing = async () => ({ ok: false, detail: "connection refused" });

describe("status", () => {
  it("is healthy with no checks", async () => {
    const health = createHealth({ service: "keeper", version: "1.2.3" });
    const status = await health.status();
    expect(status).toMatchObject({ status: "healthy", service: "keeper", version: "1.2.3", checks: {} });
    expect(typeof status.uptimeSeconds).toBe("number");
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("is healthy when every check passes", async () => {
    const health = createHealth({ service: "keeper", version: "1", checks: { rpc: ok, db: { check: ok, critical: true } } });
    const status = await health.status();
    expect(status.status).toBe("healthy");
    expect(status.checks.rpc).toMatchObject({ ok: true, critical: false });
    expect(status.checks.db).toMatchObject({ ok: true, critical: true });
    expect(typeof status.checks.rpc?.latencyMs).toBe("number");
  });

  it("is degraded when a non-critical check fails", async () => {
    const health = createHealth({ service: "keeper", version: "1", checks: { rpc: ok, cache: failing } });
    const status = await health.status();
    expect(status.status).toBe("degraded");
    expect(status.checks.cache).toMatchObject({ ok: false, critical: false, detail: "connection refused" });
  });

  it("is unhealthy when a critical check fails, even if others pass", async () => {
    const health = createHealth({
      service: "keeper",
      version: "1",
      checks: { rpc: ok, cache: failing, db: { check: failing, critical: true } },
    });
    expect((await health.status()).status).toBe("unhealthy");
  });

  it("treats a throwing check as failed with the error message", async () => {
    const health = createHealth({
      service: "keeper",
      version: "1",
      checks: {
        rpc: () => {
          throw new Error("boom");
        },
      },
    });
    const status = await health.status();
    expect(status.status).toBe("degraded");
    expect(status.checks.rpc).toMatchObject({ ok: false, detail: "boom" });
  });

  it("times out a hanging check", async () => {
    const health = createHealth({
      service: "keeper",
      version: "1",
      checkTimeoutMs: 20,
      checks: {
        slow: { check: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200)), critical: true },
        fast: { check: ok, timeoutMs: 1000 },
      },
    });
    const status = await health.status();
    expect(status.status).toBe("unhealthy");
    expect(status.checks.slow?.detail).toContain("timed out after 20ms");
    expect(status.checks.fast?.ok).toBe(true);
  });

  it("transitions as the underlying state changes", async () => {
    let up = true;
    const health = createHealth({
      service: "keeper",
      version: "1",
      checks: { rpc: { check: async () => ({ ok: up }), critical: true } },
    });
    expect((await health.status()).status).toBe("healthy");
    up = false;
    expect((await health.status()).status).toBe("unhealthy");
    up = true;
    expect((await health.status()).status).toBe("healthy");
  });
});

describe("version", () => {
  const original = process.env.GIT_SHA;
  afterEach(() => {
    if (original === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = original;
  });

  it("reports service, version and node, with the commit from GIT_SHA", () => {
    process.env.GIT_SHA = "abc123";
    const health = createHealth({ service: "prover", version: "0.1.0" });
    expect(health.version()).toEqual({ service: "prover", version: "0.1.0", commit: "abc123", node: process.version });
  });

  it("omits commit when nothing is known", () => {
    delete process.env.GIT_SHA;
    const health = createHealth({ service: "prover", version: "0.1.0" });
    expect(health.version()).toEqual({ service: "prover", version: "0.1.0", node: process.version });
  });

  it("prefers an explicit commit option", () => {
    process.env.GIT_SHA = "fromenv";
    const health = createHealth({ service: "prover", version: "0.1.0", commit: "explicit" });
    expect(health.version().commit).toBe("explicit");
  });
});
