import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { Database } from "@squaresdk/data";
import { createHealth, type CheckReport, type HealthStatus } from "@squaresdk/observability";
import { keeperChecks } from "../src/checks.js";
import type { ScreenerEndpoint } from "../src/screening.js";

const CHAIN = 5042002;
const ACCOUNT = "0xcc55417B17a31163325cB83Cf6900C98BE595e7A" as Address;
const HOOK = "0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6" as Address;
const NO_SCREENING = "0x0000000000000000000000000000000000000000" as Address;
const A_REGISTRY = "0x9A676e781A523b5d0C0e43731313A708CB607508" as Address;

function statusWith(screener?: ScreenerEndpoint, hookScreensWith: Address = NO_SCREENING): Promise<HealthStatus> {
  const db = { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pick<Database, "query">;
  const publicClient = {
    getChainId: async () => CHAIN,
    getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 0n,
    readContract: async () => hookScreensWith,
  } as unknown as Parameters<typeof keeperChecks>[0]["publicClient"];
  return createHealth({
    service: "square-keeper",
    version: "0",
    checks: keeperChecks({ db, publicClient, chainId: CHAIN, account: ACCOUNT, hook: HOOK, finalizeGas: 450_000n, ephemeralMirror: false, ...(screener ? { screener } : {}) }),
  }).status();
}

function screenerCheck(status: HealthStatus): CheckReport {
  const report = status.checks["screener"];
  if (report === undefined) throw new Error("the health report carries no screener check");
  return report;
}

// square#35: with SCREENER_URL set the screener is on the release path, so the
// keeper's /health asks it. The screener here is a real socket answering what
// services/screener's /health answers.
describe("the screener check", () => {
  let server: Server;
  let url: string;
  let reply: (response: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => (request.url === "/health" ? reply(response) : response.writeHead(404).end()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("is not there without a screener", async () => {
    expect((await statusWith()).checks["screener"]).toBeUndefined();
  });

  it("gives way to a screening check that passes while the hook screens nobody", async () => {
    const status = await statusWith();
    expect(status.checks["screening"]).toMatchObject({ ok: true, critical: true });
    expect(status.status).toBe("healthy");
  });

  it("gives way to a screening check that fails once the hook screens and no screener is set", async () => {
    const status = await statusWith(undefined, A_REGISTRY);
    expect(status.checks["screening"]).toMatchObject({ ok: false, critical: true });
    expect(status.checks["screening"]?.detail).toContain(A_REGISTRY);
    expect(status.status).toBe("unhealthy");
  });

  it("is the only screening-shaped check when a screener is configured", async () => {
    reply = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "healthy", checks: {} }));
    };
    const status = await statusWith({ url, allowPrivate: true }, A_REGISTRY);
    expect(status.checks["screening"]).toBeUndefined();
    expect(screenerCheck(status).ok).toBe(true);
  });

  it("passes, as a critical check, when the screener reports itself healthy", async () => {
    reply = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "healthy", checks: { rpc: { ok: true }, registered: { ok: true }, balance: { ok: true } } }));
    };
    const status = await statusWith({ url, allowPrivate: true });
    expect(screenerCheck(status)).toMatchObject({ ok: true, critical: true });
    expect(status.status).toBe("healthy");
  });

  it("fails the keeper's health when the screener's own fails, and names what failed", async () => {
    reply = (response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "unhealthy", checks: { rpc: { ok: true }, registered: { ok: false }, balance: { ok: true } } }));
    };
    const status = await statusWith({ url, allowPrivate: true });
    expect(screenerCheck(status)).toMatchObject({ ok: false, critical: true });
    expect(screenerCheck(status).detail).toContain("answered 503, failing: registered");
    expect(status.status).toBe("unhealthy");
  });

  it("fails when nothing answers", async () => {
    const status = await statusWith({ url: "http://127.0.0.1:1", allowPrivate: true });
    expect(screenerCheck(status).ok).toBe(false);
    expect(status.status).toBe("unhealthy");
  });

  it("fails on a link-local screener URL without sending it anything", async () => {
    const status = await statusWith({ url: "http://169.254.169.254", allowPrivate: true });
    expect(screenerCheck(status).ok).toBe(false);
    expect(screenerCheck(status).detail).toMatch(/link_local/);
  });
});
