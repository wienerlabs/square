import { Hono } from "hono";
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
