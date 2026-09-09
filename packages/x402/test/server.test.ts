import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC } from "../src/network.js";
import { BEFORE_HANDLER_UNSUPPORTED, createGatewayApp, createPaidRoutes, parseRoutePattern } from "../src/server.js";

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
const base = {
  payTo: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const,
  network: ARC_TESTNET_NETWORK,
  facilitator,
  asset: ARC_TESTNET_USDC,
};

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
