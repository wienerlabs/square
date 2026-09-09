import type { Database } from "./database.js";
import * as idempotencyKeys from "./repositories/idempotencyKeys.js";
import * as keeperActions from "./repositories/keeperActions.js";
import * as rateLimits from "./repositories/rateLimits.js";
import * as x402Payments from "./repositories/x402Payments.js";

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export interface SweepOptions {
  rateLimitWindowMs?: number | undefined;
}

export interface SweepResult {
  idempotency_keys: number;
  rate_limits: number;
  x402_payments: number;
  keeper_actions: number;
}

export async function sweepAll(db: Database, options: SweepOptions = {}): Promise<SweepResult> {
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  return {
    idempotency_keys: await idempotencyKeys.sweepExpired(db),
    rate_limits: await rateLimits.sweep(db, rateLimitWindowMs),
    x402_payments: await x402Payments.sweep(db),
    keeper_actions: await keeperActions.sweep(db),
  };
}
