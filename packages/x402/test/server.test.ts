import { describe, expect, it } from "vitest";
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

describe("a parameterised paid route on createGatewayApp", () => {
  function gatewayFor(pattern: string) {
    const accepting = acceptingFacilitator();
    const app = createGatewayApp({
      payTo,
      network: ARC_TESTNET_NETWORK,
      facilitator: accepting,
      asset: ARC_TESTNET_USDC,
      routes: { [pattern]: { price: "0.05", description: "One job", handler: (c) => c.json({ id: c.req.param("id") }) } },
    });
    const payingFetch = createPayingFetch({
      account: payer,
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      maxAmountPerPayment: "1.00",
      fetch: async (input, init) => app.request(input as Parameters<typeof app.request>[0], init),
    });
    return { app, accepting, payingFetch };
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
    ["GET /jobs/[id]", "/jobs/1"],
    ["GET /jobs/:id", "/jobs/1"],
    ["GET /quote", "/quote"],
    ["GET /files/*", "/files/a/b"],
    ["/quote", "/quote"],
  ])("%s never serves %s for free", async (pattern, path) => {
    const { app } = gatewayFor(pattern);

    const res = await app.request(`http://gateway.local${path}`);

    expect(res.status).toBe(402);
  });

  it("leaves /health free", async () => {
    const { app } = gatewayFor("GET /jobs/[id]");

    const res = await app.request("http://gateway.local/health");

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});
