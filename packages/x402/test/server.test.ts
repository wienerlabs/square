import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from "../src/network.js";
import {
  BEFORE_HANDLER_UNSUPPORTED,
  createGatewayApp,
  createPaidRoutes,
  parseRoutePattern,
  routeCollisionMessage,
  routePatternKey,
} from "../src/server.js";
import { createPayingFetch } from "../src/client.js";
import { PAYER_KEY } from "./anvil.js";

const facilitator: FacilitatorClient = {
  verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    return Promise.resolve({ isValid: false, invalidReason: "unsupported_scheme" } as VerifyResponse);
  },
  settle(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<SettleResponse> {
    return Promise.resolve({ success: false } as SettleResponse);
  },
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({ kinds: [], signers: {} } as unknown as SupportedResponse);
  },
};

const routes = { "GET /quote": { price: "0.05" } };
const payTo = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const base = {
  payTo,
  network: ARC_TESTNET_NETWORK,
  facilitator,
  asset: ARC_TESTNET_USDC,
};

const payer = privateKeyToAccount(PAYER_KEY);
const SETTLEMENT_TX = ("0x" + "ab".repeat(32)) as Hex;

interface AcceptingFacilitator extends FacilitatorClient {
  readonly verified: PaymentRequirements[];
  readonly settled: PaymentRequirements[];
}

function acceptingFacilitator(): AcceptingFacilitator {
  const verified: PaymentRequirements[] = [];
  const settled: PaymentRequirements[] = [];
  return {
    verified,
    settled,
    verify(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
      verified.push(requirements);
      return Promise.resolve({ isValid: true, payer: payer.address } as VerifyResponse);
    },
    settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      settled.push(requirements);
      return Promise.resolve({
        success: true,
        transaction: SETTLEMENT_TX,
        network: ARC_TESTNET_NETWORK,
        payer: payer.address,
      } as unknown as SettleResponse);
    },
    getSupported(): Promise<SupportedResponse> {
      return Promise.resolve({
        kinds: [{ x402Version: 2, scheme: "exact", network: ARC_TESTNET_NETWORK }],
        signers: { "eip155:*": [payTo] },
      } as unknown as SupportedResponse);
    },
  };
}

describe("createPaidRoutes", () => {
  it("mounts the default after-handler flow", () => {
    expect(() => createPaidRoutes({ ...base, routes })).not.toThrow();
    expect(() => createPaidRoutes({ ...base, routes, settlement: "after-handler" })).not.toThrow();
  });

  it("refuses before-handler at configuration time rather than losing replay protection", () => {
    expect(() => createPaidRoutes({ ...base, routes, settlement: "before-handler" })).toThrow(BEFORE_HANDLER_UNSUPPORTED);
    expect(() =>
      createGatewayApp({
        ...base,
        routes: { "GET /quote": { price: "0.05", handler: (c) => c.json({ ok: true }) } },
        settlement: "before-handler",
      }),
    ).toThrow(BEFORE_HANDLER_UNSUPPORTED);
  });
});

describe("parseRoutePattern", () => {
  it("splits a verb from a path and turns bracket segments into parameters", () => {
    expect(parseRoutePattern("GET /quote")).toEqual({ method: "GET", path: "/quote" });
    expect(parseRoutePattern("/quote")).toEqual({ method: "*", path: "/quote" });
    expect(parseRoutePattern("get /jobs/[id]")).toEqual({ method: "GET", path: "/jobs/:id" });
  });
});

describe("routePatternKey", () => {
  it("puts both dialects into the one form the payment side and the handler side share", () => {
    expect(routePatternKey(parseRoutePattern("get /jobs/[id]"))).toBe("GET /jobs/:id");
    expect(routePatternKey(parseRoutePattern("GET /jobs/:id"))).toBe("GET /jobs/:id");
    expect(routePatternKey(parseRoutePattern("GET /quote"))).toBe("GET /quote");
    expect(routePatternKey(parseRoutePattern("/quote"))).toBe("/quote");
    expect(routePatternKey(parseRoutePattern("GET /files/*"))).toBe("GET /files/*");
  });
});

describe("two route keys that collapse to one canonical route", () => {
  const expensive = { price: "1.00", description: "Bracket", handler: (c: Context) => c.json({ from: "bracket" }) };
  const cheap = { price: "0.01", description: "Colon", handler: (c: Context) => c.json({ from: "colon" }) };

  it.each([
    ["GET /jobs/[id]", "GET /jobs/:id", "GET /jobs/:id"],
    ["get /jobs/:id", "GET /jobs/:id", "GET /jobs/:id"],
    ["GET  /jobs/:id", "GET /jobs/:id", "GET /jobs/:id"],
  ])("refuses %s alongside %s at construction time", (first, second, key) => {
    expect(() =>
      createGatewayApp({ ...base, routes: { [first]: expensive, [second]: cheap } }),
    ).toThrow(routeCollisionMessage(first, second, key));
  });

  it("names both spellings and the canonical form they share", () => {
    expect(() =>
      createGatewayApp({ ...base, routes: { "GET /jobs/[id]": expensive, "GET /jobs/:id": cheap } }),
    ).toThrow('"GET /jobs/[id]" and "GET /jobs/:id" both mean "GET /jobs/:id"');
  });

  it("never sells the surviving handler at the losing price", () => {
    const accepting = acceptingFacilitator();

    expect(() =>
      createGatewayApp({
        payTo,
        network: ARC_TESTNET_NETWORK,
        facilitator: accepting,
        asset: ARC_TESTNET_USDC,
        routes: { "GET /jobs/[id]": expensive, "GET /jobs/:id": cheap },
      }),
    ).toThrow(/collapse to the same route/);
    expect(accepting.verified).toHaveLength(0);
    expect(accepting.settled).toHaveLength(0);
  });

  it("leaves a verb-less key and a verb-carrying key on the same path alone", () => {
    expect(() =>
      createGatewayApp({ ...base, routes: { "/jobs/:id": expensive, "GET /jobs/:id": cheap } }),
    ).not.toThrow();
  });
});

describe("distinct route keys on createGatewayApp", () => {
  it("keeps one price per route and is untouched by the collision guard", async () => {
    const accepting = acceptingFacilitator();
    const app = createGatewayApp({
      payTo,
      network: ARC_TESTNET_NETWORK,
      facilitator: accepting,
      asset: ARC_TESTNET_USDC,
      routes: {
        "GET /jobs/[id]": { price: "1.00", description: "One job", handler: (c) => c.json({ id: c.req.param("id") }) },
        "POST /jobs": { price: "0.01", description: "Submit a job", handler: (c) => c.json({ accepted: true }) },
      },
    });
    const payingFetch = createPayingFetch({
      account: payer,
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      maxAmountPerPayment: "1.00",
      fetch: async (input, init) => app.request(input as Parameters<typeof app.request>[0], init),
    });

    const read = await payingFetch("http://gateway.local/jobs/7");
    const write = await payingFetch("http://gateway.local/jobs", { method: "POST" });

    expect(await read.json()).toEqual({ id: "7" });
    expect(await write.json()).toEqual({ accepted: true });
    expect(accepting.settled.map((requirements) => requirements.amount)).toEqual(["1000000", "10000"]);
  });
});

describe("a parameterised paid route on createGatewayApp", () => {
  function gatewayFor(pattern: string) {
    const accepting = acceptingFacilitator();
    let handlerRuns = 0;
    const app = createGatewayApp({
      payTo,
      network: ARC_TESTNET_NETWORK,
      facilitator: accepting,
      asset: ARC_TESTNET_USDC,
      routes: {
        [pattern]: {
          price: "0.05",
          description: "One job",
          handler: (c) => {
            handlerRuns += 1;
            return c.json({ id: c.req.param("id") }, 200, { "x-quote": "42 USDC" });
          },
        },
      },
    });
    const payingFetch = createPayingFetch({
      account: payer,
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      maxAmountPerPayment: "1.00",
      fetch: async (input, init) => app.request(input as Parameters<typeof app.request>[0], init),
    });
    return { app, accepting, payingFetch, handlerRuns: () => handlerRuns };
  }

  it.each(["GET /jobs/[id]", "GET /jobs/:id"])("%s answers /jobs/1 with 402 when nothing is paid", async (pattern) => {
    const { app } = gatewayFor(pattern);

    const res = await app.request("http://gateway.local/jobs/1");

    expect(res.status).toBe(402);
    expect(res.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
  });

  it.each(["GET /jobs/[id]", "GET /jobs/:id"])("%s runs the handler once the request is paid", async (pattern) => {
    const { accepting, payingFetch } = gatewayFor(pattern);

    const res = await payingFetch("http://gateway.local/jobs/1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "1" });
    expect(accepting.verified).toHaveLength(1);
    expect(accepting.settled).toHaveLength(1);
    expect(accepting.verified[0]?.amount).toBe("50000");
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy();
  });

  it.each([
    ["GET /jobs/[id]", "/jobs/1", "GET", 402],
    ["GET /jobs/[id]", "/jobs/1", "HEAD", 402],
    ["GET /jobs/[id]", "/jobs/1", "POST", 404],
    ["GET /jobs/[id]", "/jobs/1", "OPTIONS", 404],
    ["GET /jobs/:id", "/jobs/1", "GET", 402],
    ["GET /jobs/:id", "/jobs/1", "HEAD", 402],
    ["GET /jobs/:id", "/jobs/1", "POST", 404],
    ["GET /jobs/:id", "/jobs/1", "OPTIONS", 404],
    ["GET /quote", "/quote", "GET", 402],
    ["GET /quote", "/quote", "HEAD", 402],
    ["GET /quote", "/quote", "POST", 404],
    ["GET /quote", "/quote", "OPTIONS", 404],
    ["GET /files/*", "/files/a/b", "GET", 402],
    ["GET /files/*", "/files/a/b", "HEAD", 402],
    ["GET /files/*", "/files/a/b", "POST", 404],
    ["GET /files/*", "/files/a/b", "OPTIONS", 404],
    ["/quote", "/quote", "GET", 402],
    ["/quote", "/quote", "HEAD", 402],
    ["/quote", "/quote", "POST", 402],
    ["/quote", "/quote", "OPTIONS", 402],
  ] as const)("%s never serves %s for free: %s answers %i", async (pattern, path, method, status) => {
    const { app, accepting, handlerRuns } = gatewayFor(pattern);

    const res = await app.request(`http://gateway.local${path}`, { method });

    expect(res.status).toBe(status);
    expect(handlerRuns()).toBe(0);
    expect(accepting.verified).toHaveLength(0);
    expect(accepting.settled).toHaveLength(0);
    expect(res.headers.get("x-quote")).toBeNull();
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
  });

  it("does not let HEAD walk the paid GET chain that Hono re-dispatches it into", async () => {
    const { app, handlerRuns } = gatewayFor("GET /quote");

    const head = await app.request("http://gateway.local/quote", { method: "HEAD" });

    expect(head.status).toBe(402);
    expect(head.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(handlerRuns()).toBe(0);
  });

  it("keeps serving a paid GET once the payment is made, HEAD twin or not", async () => {
    const { payingFetch, handlerRuns } = gatewayFor("GET /quote");

    const res = await payingFetch("http://gateway.local/quote");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-quote")).toBe("42 USDC");
    expect(handlerRuns()).toBe(1);
  });

  it("leaves /health free", async () => {
    const { app } = gatewayFor("GET /jobs/[id]");

    const res = await app.request("http://gateway.local/health");

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});
