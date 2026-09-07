import { Hono, type Context, type MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress, type Address } from "viem";
import { ARC_TESTNET_USDC, usdcAsset } from "./network.js";

export type SettlementMode = "after-handler" | "before-handler";

export interface PaidRouteConfig {
  price: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
}

export interface PaidRoutesOptions {
  payTo: Address;
  network: Network;
  facilitator: FacilitatorClient;
  routes: Record<string, PaidRouteConfig>;
  asset?: Address;
  settlement?: SettlementMode;
}

export type GatewayHandler = (c: Context) => Response | Promise<Response>;

export interface GatewayRoute extends PaidRouteConfig {
  handler: GatewayHandler;
}

export interface GatewayAppOptions {
  payTo: Address;
  network: Network;
  facilitator: FacilitatorClient;
  routes: Record<string, GatewayRoute>;
  asset?: Address;
  settlement?: SettlementMode;
}

export function createPaidRoutes(options: PaidRoutesOptions): MiddlewareHandler {
  const asset = options.asset ?? ARC_TESTNET_USDC;
  const settlement = options.settlement ?? "after-handler";
  const payTo = getAddress(options.payTo);
  const server = new x402ResourceServer(options.facilitator).register(
    options.network,
    new ExactEvmScheme()
  );
  const routes: Record<string, RouteConfig> = {};
  for (const [pattern, route] of Object.entries(options.routes)) {
    routes[pattern] = {
      accepts: {
        scheme: "exact",
        payTo,
        network: options.network,
        price: usdcAsset(route.price, asset),
        ...(route.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: route.maxTimeoutSeconds } : {}),
        ...(settlement === "before-handler" ? { extra: { paymentFlow: "upfront" } } : {}),
      },
      mimeType: route.mimeType ?? "application/json",
      ...(route.description !== undefined ? { description: route.description } : {}),
    };
  }
  return paymentMiddleware(routes, server);
}

export function parseRoutePattern(pattern: string): { method: string; path: string } {
  const trimmed = pattern.trim();
  const parts = trimmed.split(/\s+/);
  const method = parts.length > 1 ? (parts[0] ?? "*").toUpperCase() : "*";
  const rawPath = parts.length > 1 ? (parts[1] ?? "/") : trimmed;
  const path = rawPath.replace(/\[([^\]]+)\]/g, ":$1");
  return { method, path };
}

export function createGatewayApp(options: GatewayAppOptions): Hono {
  const asset = options.asset ?? ARC_TESTNET_USDC;
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ ok: true, network: options.network, payTo: getAddress(options.payTo), asset })
  );
  const paidRoutes: Record<string, PaidRouteConfig> = {};
  for (const [pattern, route] of Object.entries(options.routes)) {
    const { handler, ...config } = route;
    void handler;
    paidRoutes[pattern] = config;
  }
  app.use(
    "*",
    createPaidRoutes({
      payTo: options.payTo,
      network: options.network,
      facilitator: options.facilitator,
      routes: paidRoutes,
      asset,
      ...(options.settlement !== undefined ? { settlement: options.settlement } : {}),
    })
  );
  for (const [pattern, route] of Object.entries(options.routes)) {
    const { method, path } = parseRoutePattern(pattern);
    if (method === "*") {
      app.all(path, route.handler);
    } else {
      app.on(method, path, route.handler);
    }
  }
  return app;
}
