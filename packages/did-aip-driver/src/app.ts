import express, { type Express, type NextFunction, type Request, type Response } from "express";
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
  ...(config.allowedAgentUriHosts ? { allowedAgentUriHosts: config.allowedAgentUriHosts } : {}),
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
  //
  // The parameter is taken as Express hands it over, decoded exactly once.
  // Decoding it again here would let `%253A` reach the resolver as a colon, so
  // two different request paths would name the same DID and a DID the client
  // never asked for could be resolved; and `decodeURIComponent("%")` throws,
  // which outside the try below is an unhandled rejection that ends the
  // process. Express's own decode failure goes to the error handler at the
  // bottom instead.
  app.get("/1.0/identifiers/:did(*)", async (req, res) => {
    try {
      res.type(DID_LD_JSON);
      const result = await resolver.resolve(req.params.did ?? "");
      res.status(statusFor(result)).json(toEnvelope(result));
    } catch (err) {
      // resolve() is built not to throw. Reaching here means something the
      // resolver did not anticipate, which is a driver fault, not a bad DID.
      console.error("[did:aip-driver] unexpected error:", err);
      res.status(500).json(errorEnvelope("internalError", err instanceof Error ? err.message : String(err)));
    }
  });

  // Whatever escapes a route still answers in the envelope. The one error
  // Express raises on this path by itself is a parameter that is not valid
  // percent-encoding (`GET /1.0/identifiers/%25`): it carries status 400, and
  // the honest name for it is invalidDid. Without this the default handler
  // answers with an HTML page, and anything without a status would be a 500
  // with a stack trace in the body.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown }).status;
    res.type(DID_LD_JSON);
    if (status === 400) {
      res.status(400).json(errorEnvelope("invalidDid", "the identifier is not valid percent-encoding"));
      return;
    }
    console.error("[did:aip-driver] unexpected error:", err);
    res.status(500).json(errorEnvelope("internalError", err instanceof Error ? err.message : String(err)));
  });

  return app;
}
