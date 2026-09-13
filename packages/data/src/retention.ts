import type { Database } from "./database.js";
import * as idempotencyKeys from "./repositories/idempotencyKeys.js";
import * as keeperActions from "./repositories/keeperActions.js";
import * as rateLimits from "./repositories/rateLimits.js";
import * as x402Payments from "./repositories/x402Payments.js";

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export interface SweepOptions {
  rateLimitWindowMs?: number | undefined;
}

export interface SweepCounts {
  idempotency_keys: number;
  rate_limits: number;
  x402_payments: number;
  keeper_actions: number;
}

export type SweptTable = keyof SweepCounts;

export interface SweepFailure {
  table: SweptTable;
  message: string;
}

export interface SweepResult {
  removed: SweepCounts;
  failures: SweepFailure[];
}

export async function sweepAll(db: Database, options: SweepOptions = {}): Promise<SweepResult> {
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const sweeps: Array<[SweptTable, () => Promise<number>]> = [
    ["idempotency_keys", () => idempotencyKeys.sweepExpired(db)],
    ["rate_limits", () => rateLimits.sweep(db, rateLimitWindowMs)],
    ["x402_payments", () => x402Payments.sweep(db)],
    ["keeper_actions", () => keeperActions.sweep(db)],
  ];
  const removed: SweepCounts = { idempotency_keys: 0, rate_limits: 0, x402_payments: 0, keeper_actions: 0 };
  const failures: SweepFailure[] = [];
  for (const [table, run] of sweeps) {
    try {
      removed[table] = await run();
    } catch (error) {
      failures.push({ table, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failures };
}
