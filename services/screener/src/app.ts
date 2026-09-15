import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address, Hex } from "viem";
import type { createHealth, createLogger, createMetrics } from "@squaresdk/observability";
import { observabilityRoutes } from "@squaresdk/observability/hono";
import { ScreeningRefused, type SignedScreening } from "./screen.js";

/** Milliseconds: the source's answer, and the submission until its receipt. */
export interface ScreeningTimings {
  sourceMs: number;
  submitMs: number;
}

export interface ScreenerService {
  screen(
    subjects: readonly unknown[],
  ): Promise<{ screenings: SignedScreening[]; recorded: ReadonlySet<Address>; transactionHash: Hex; timings: ScreeningTimings }>;
}

export interface ScreenerAppOptions {
  service: ScreenerService;
  health: ReturnType<typeof createHealth>;
  metrics: ReturnType<typeof createMetrics>;
  logger: ReturnType<typeof createLogger>;
  /**
   * Origins a browser may call this service from, beyond `localhost` on any
   * port, which is always allowed: `CORS_ORIGINS`, read by `corsOriginsFrom`.
   */
  corsOrigins?: readonly string[];
}

const LOCALHOST = /^http:\/\/localhost:\d+$/;

/**
 * `CORS_ORIGINS`, comma-separated, as a list.
 *
 * square#374: the app's fund step calls `POST /screen` from the browser
 * (square#373, `NEXT_PUBLIC_SCREENER_URL`), and a service that writes no CORS
 * headers stops that call at the preflight. The prover has had the same rule
 * all along (services/prover/src/index.js): localhost on any port, and the
 * origins this variable names.
 */
export function corsOriginsFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * `POST /screen` with `{"addresses": ["0x…", …]}`: screen, sign, record, and
 * answer with what was signed and, for each, whether this transaction recorded
 * it. One it did not record was skipped because the registry already held a
 * record for that address from the same second, and that record is what the
 * registry answers with. Every refusal is an answer with nothing attested;
 * there is no response that says "cleared" without a transaction behind it.
 */
export function screenerApp(options: ScreenerAppOptions): Hono {
  const app = new Hono();
  // The two routes a browser calls. An origin that is neither localhost nor
  // named gets no Access-Control-Allow-Origin, so its browser stops the call.
  const extra = options.corsOrigins ?? [];
  const browsers = cors({
    origin: (origin) => (LOCALHOST.test(origin) || extra.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST"],
  });
  app.use("/screen", browsers);
  app.use("/health", browsers);
  app.route("/", observabilityRoutes({ health: options.health, metrics: options.metrics }));
  app.post("/screen", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "the body is not JSON" }, 400);
    }
    const addresses = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["addresses"] : undefined;
    if (!Array.isArray(addresses)) return c.json({ error: 'expected {"addresses": ["0x…", …]}' }, 400);
    try {
      const { screenings, recorded, transactionHash, timings } = await options.service.screen(addresses);
      return c.json({
        transactionHash,
        timings,
        screenings: screenings.map(({ screening, signature }) => ({
          ...screening,
          screenedAt: screening.screenedAt.toString(),
          signature,
          recorded: recorded.has(screening.subject),
        })),
      });
    } catch (error) {
      if (error instanceof ScreeningRefused) {
        options.logger.warn("screener.refused", { reason: error.message });
        return c.json({ error: error.message }, error.status);
      }
      options.logger.error("screener.failed", { error: error instanceof Error ? error.message : String(error) });
      return c.json({ error: "the screening could not be recorded, so nothing was attested" }, 502);
    }
  });
  return app;
}
