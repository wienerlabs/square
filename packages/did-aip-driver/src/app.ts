import express, { type Express } from "express";
import { AipDidResolver } from "@squaresdk/did-resolver";
import type { DriverConfig } from "./config.js";
import { DID_LD_JSON, errorEnvelope, statusFor, toEnvelope } from "./envelope.js";

/**
 * The driver as an Express app, without listening. server.ts binds a port;
 * tests drive this directly, so the HTTP behaviour is testable without one.
 */
export function createApp(config: DriverConfig, resolver = new AipDidResolver({
  rpc: config.rpc,
  timeoutMs: config.timeoutMs,
  ...(config.allowedRegistries ? { allowedRegistries: config.allowedRegistries } : {}),
})): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", chains: Object.keys(config.rpc).map(Number) });
  });

  // The Universal Resolver's single endpoint. `:did` is greedy on purpose —
  // a did:aip v2 identifier contains colons, and Express would otherwise stop
  // at the first one and hand us a truncated DID that fails to parse for the
  // wrong reason.
  app.get("/1.0/identifiers/:did(*)", async (req, res) => {
    res.type(DID_LD_JSON);
    const did = decodeURIComponent(req.params.did ?? "");
    try {
      const result = await resolver.resolve(did);
      res.status(statusFor(result)).json(toEnvelope(result));
    } catch (err) {
      // resolve() is built not to throw. Reaching here means something the
      // resolver did not anticipate, which is a driver fault, not a bad DID.
      console.error("[did:aip-driver] unexpected error:", err);
      res.status(500).json(errorEnvelope("internalError", err instanceof Error ? err.message : String(err)));
    }
  });

  return app;
}
