import type { Context, MiddlewareHandler } from "hono";
import type { SqlClient } from "./sql.js";

export interface RateLimitStore {
  increment(bucket: string, windowStart: number): Promise<number>;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  count: number;
}

export interface RateLimiterOptions<Ctx> {
  limit: number;
  windowMs: number;
  keyOf: (ctx: Ctx) => string;
  now?: (() => number) | undefined;
}

export interface RateLimiter<Ctx> {
  check(ctx: Ctx): Promise<RateLimitDecision>;
}

export function rateLimiter<Ctx>(store: RateLimitStore, options: RateLimiterOptions<Ctx>): RateLimiter<Ctx> {
  if (!(options.limit > 0) || !(options.windowMs > 0)) throw new RangeError("limit and windowMs must be positive");
  const now = options.now ?? Date.now;
  return {
    async check(ctx) {
      const windowStart = Math.floor(now() / options.windowMs) * options.windowMs;
      const count = await store.increment(options.keyOf(ctx), windowStart);
      return {
        allowed: count <= options.limit,
        limit: options.limit,
        remaining: Math.max(0, options.limit - count),
        resetAt: windowStart + options.windowMs,
        count,
      };
    },
  };
}

export function memoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    async increment(bucket, windowStart) {
      const current = windows.get(bucket);
      if (current !== undefined && current.windowStart === windowStart) {
        current.count += 1;
        return current.count;
      }
      windows.set(bucket, { windowStart, count: 1 });
      return 1;
    },
  };
}

export const RATE_LIMIT_TABLE_SQL = `create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null,
  primary key (bucket, window_start)
)`;

const RATE_LIMIT_INCREMENT_SQL = `insert into rate_limits (bucket, window_start, count)
values ($1, $2::timestamptz, 1)
on conflict (bucket, window_start) do update set count = rate_limits.count + 1
returning count`;

const RATE_LIMIT_PRUNE_SQL = `delete from rate_limits where window_start < $1::timestamptz`;

export interface PostgresRateLimitStore extends RateLimitStore {
  prune(olderThanMs: number): Promise<void>;
}

export function postgresRateLimitStore(db: SqlClient): PostgresRateLimitStore {
  return {
    async increment(bucket, windowStart) {
      const result = await db.query(RATE_LIMIT_INCREMENT_SQL, [bucket, new Date(windowStart).toISOString()]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("rate limit increment returned no row");
      return Number(row["count"]);
    },
    async prune(olderThanMs) {
      await db.query(RATE_LIMIT_PRUNE_SQL, [new Date(olderThanMs).toISOString()]);
    },
  };
}

export type RateLimitMiddlewareOptions = RateLimiterOptions<Context>;

export function rateLimitMiddleware(store: RateLimitStore, options: RateLimitMiddlewareOptions): MiddlewareHandler {
  const limiter = rateLimiter(store, options);
  const now = options.now ?? Date.now;
  return async (c, next) => {
    const decision = await limiter.check(c);
    const resetSeconds = Math.max(0, Math.ceil((decision.resetAt - now()) / 1000));
    const headers = {
      "RateLimit-Limit": String(decision.limit),
      "RateLimit-Remaining": String(decision.remaining),
      "RateLimit-Reset": String(resetSeconds),
    };
    if (!decision.allowed) {
      return c.json({ error: "rate_limited", retryAfterSeconds: resetSeconds }, 429, {
        ...headers,
        "Retry-After": String(resetSeconds),
      });
    }
    await next();
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
  };
}
