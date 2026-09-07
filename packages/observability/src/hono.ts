import { Hono } from "hono";
import { observabilityHandlers, resolvePaths, type ObservabilityOptions, type ObservabilityResponse } from "./http.js";

function toResponse(response: ObservabilityResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.contentType },
  });
}

export function observabilityRoutes(options: ObservabilityOptions): Hono {
  const handlers = observabilityHandlers(options);
  const paths = resolvePaths(options.paths);
  const app = new Hono();
  app.get(paths.health, async () => toResponse(await handlers.health()));
  app.get(paths.metrics, async () => toResponse(await handlers.metrics()));
  app.get(paths.version, () => toResponse(handlers.version()));
  return app;
}
