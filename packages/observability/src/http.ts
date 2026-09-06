import type { Registry } from "prom-client";
import type { Health } from "./health.js";
import { renderMetrics } from "./metrics.js";

export interface ObservabilityPaths {
  health?: string;
  metrics?: string;
  version?: string;
}

export interface ResolvedPaths {
  health: string;
  metrics: string;
  version: string;
}

export interface ObservabilityOptions {
  health: Health;
  metrics: { registry: Registry };
  paths?: ObservabilityPaths;
}

export interface ObservabilityResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface ObservabilityHandlers {
  health(): Promise<ObservabilityResponse>;
  metrics(): Promise<ObservabilityResponse>;
  version(): ObservabilityResponse;
}

export interface ExpressLikeResponse {
  status(code: number): unknown;
  set(field: string, value: string): unknown;
  send(body: string): unknown;
}

export type ExpressLikeHandler = (req: unknown, res: ExpressLikeResponse) => void;

export interface ExpressLikeApp {
  get(path: string, handler: ExpressLikeHandler): unknown;
}

export const DEFAULT_PATHS: Readonly<ResolvedPaths> = Object.freeze({
  health: "/health",
  metrics: "/metrics",
  version: "/version",
});

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function resolvePaths(paths?: ObservabilityPaths): ResolvedPaths {
  return {
    health: paths?.health ?? DEFAULT_PATHS.health,
    metrics: paths?.metrics ?? DEFAULT_PATHS.metrics,
    version: paths?.version ?? DEFAULT_PATHS.version,
  };
}

function failure(error: unknown): ObservabilityResponse {
  return {
    status: 500,
    contentType: JSON_CONTENT_TYPE,
    body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
  };
}

export function observabilityHandlers({ health, metrics }: ObservabilityOptions): ObservabilityHandlers {
  return {
    async health() {
      try {
        const report = await health.status();
        return {
          status: report.status === "unhealthy" ? 503 : 200,
          contentType: JSON_CONTENT_TYPE,
          body: JSON.stringify(report),
        };
      } catch (error) {
        return failure(error);
      }
    },
    async metrics() {
      try {
        return {
          status: 200,
          contentType: metrics.registry.contentType,
          body: await renderMetrics(metrics.registry),
        };
      } catch (error) {
        return failure(error);
      }
    },
    version() {
      return { status: 200, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(health.version()) };
    },
  };
}

function reply(res: ExpressLikeResponse, response: ObservabilityResponse): void {
  res.status(response.status);
  res.set("Content-Type", response.contentType);
  res.send(response.body);
}

export function mountObservability(app: ExpressLikeApp, options: ObservabilityOptions): void {
  const handlers = observabilityHandlers(options);
  const paths = resolvePaths(options.paths);
  app.get(paths.health, (_req, res) => {
    void handlers.health().then((response) => reply(res, response));
  });
  app.get(paths.metrics, (_req, res) => {
    void handlers.metrics().then((response) => reply(res, response));
  });
  app.get(paths.version, (_req, res) => {
    reply(res, handlers.version());
  });
}
