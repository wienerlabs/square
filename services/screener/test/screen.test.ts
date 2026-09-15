import { describe, expect, it } from "vitest";
import { hexToString, recoverTypedDataAddress, stringToHex, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MAX_SUBJECTS,
  SCREENING_DOMAIN_NAME,
  SCREENING_DOMAIN_VERSION,
  SCREENING_TYPES,
  ScreeningRefused,
  TRM_SOURCE_ID,
  TrmSanctionsSource,
  screenAndSign,
  signScreening,
} from "../src/index.js";
import { createHealth, createLogger, createMetrics } from "@squaresdk/observability";
import { corsOriginsFrom, screenerApp, type ScreenerService } from "../src/app.js";

const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;

// Every refusal here happens before the source is asked, which is the property
// under test: a malformed request costs nothing and attests nothing. The source
// is the real one, and none of these requests reaches it.
describe("a request is refused before the source is asked", () => {
  const options = {
    source: new TrmSanctionsSource(),
    canary: fresh(),
    signer: privateKeyToAccount(generatePrivateKey()),
    domain: { chainId: 5042002, registry: fresh() },
  };

  it.each([
    ["no addresses", []],
    ["too many", Array.from({ length: MAX_SUBJECTS + 1 }, fresh)],
    ["something that is not an address", ["0x1234"]],
    ["the zero address", [zeroAddress]],
  ])("%s", async (_, input) => {
    await expect(screenAndSign(options, input)).rejects.toMatchObject({ name: "ScreeningRefused", status: 400 });
  });

  it("the same address twice, in any case", async () => {
    const a = fresh();
    await expect(screenAndSign(options, [a, a.toLowerCase()])).rejects.toBeInstanceOf(ScreeningRefused);
  });

  it("the canary as a subject", async () => {
    await expect(screenAndSign(options, [options.canary])).rejects.toThrow(/canary is not a subject/);
  });
});

describe("what the screener signs", () => {
  it("recovers to the screener under the registry's domain", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const domain = { chainId: 5042002, registry: fresh() };
    const screening = {
      subject: fresh(),
      sanctioned: false,
      screenedAt: 1_788_356_730n,
      source: stringToHex(TRM_SOURCE_ID, { size: 32 }),
      evidence: stringToHex("evidence", { size: 32 }),
    };
    const signature = await signScreening(signer, domain, screening);
    const recovered = await recoverTypedDataAddress({
      domain: { name: SCREENING_DOMAIN_NAME, version: SCREENING_DOMAIN_VERSION, chainId: domain.chainId, verifyingContract: domain.registry },
      types: SCREENING_TYPES,
      primaryType: "Screening",
      message: screening,
      signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("names its source in a bytes32 that reads back as the id", () => {
    expect(hexToString(stringToHex(TRM_SOURCE_ID, { size: 32 }), { size: 32 })).toBe(TRM_SOURCE_ID);
  });
});

// square#374. The app funds from the browser and calls POST /screen first
// (square#373); with no CORS headers the preflight stopped it and the app said
// the screener could not be reached. What a browser checks is the preflight's
// Access-Control-Allow-Origin, so that is what is asserted, for the origins the
// rule names and for one it does not.
describe("a browser calling the screener", () => {
  const APP = "https://square-wienerlabs.vercel.app";
  const service: ScreenerService = {
    screen: async () => {
      throw new Error("a preflight or a malformed request never reaches the source");
    },
  };
  const app = screenerApp({
    service,
    health: createHealth({ service: "square-screener", version: "test", checks: {} }),
    metrics: createMetrics({ service: "square-screener" }),
    logger: createLogger({ service: "square-screener", version: "test" }),
    corsOrigins: corsOriginsFrom(` ${APP} ,, https://other.example `),
  });
  const preflight = (origin: string, path = "/screen") =>
    app.request(path, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });

  it("reads CORS_ORIGINS as a comma-separated list, blanks dropped", () => {
    expect(corsOriginsFrom(` ${APP} ,, https://other.example `)).toEqual([APP, "https://other.example"]);
    expect(corsOriginsFrom(undefined)).toEqual([]);
    expect(corsOriginsFrom("")).toEqual([]);
  });

  it("answers the preflight of an origin CORS_ORIGINS names, for POST and the JSON body", async () => {
    const response = await preflight(APP);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("allows localhost on any port, as the prover does", async () => {
    for (const origin of ["http://localhost:3000", "http://localhost:5173"]) {
      expect((await preflight(origin)).headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("writes no Access-Control-Allow-Origin for an origin it does not name", async () => {
    for (const origin of ["https://evil.example", "https://square-wienerlabs.vercel.app.evil.example", "http://localhost.evil.example:3000", "https://localhost:3000"]) {
      expect((await preflight(origin)).headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("carries the header on the answer itself, so the browser can read a refusal", async () => {
    const response = await app.request("/screen", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: "not json" });
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    const other = await app.request("/screen", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "not json" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers GET /health's preflight for a named origin", async () => {
    expect((await preflight(APP, "/health")).headers.get("access-control-allow-origin")).toBe(APP);
  });
});
