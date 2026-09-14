import type { ToolResult, ToolSuccess } from "./types.js";

export interface ToolResultCacheOptions {
  /** How long a result answers for. Default five minutes. */
  ttlMs?: number | undefined;
  /** Entries kept; the least recently used goes first. Default 256. */
  maxEntries?: number | undefined;
  now?: (() => number) | undefined;
}

interface Entry {
  result: ToolSuccess;
  expiresAt: number;
}

/**
 * Remembers what a tool answered, per tool and arguments.
 *
 * A model in a tool loop asks the same question twice more often than one
 * would like, and an agent serving the same task input twice asks it twice
 * by construction. Only successes are kept: a failure is worth asking again
 * about. Bounded, because the predecessor's was not, and a pool that lives
 * for the life of an agent process would grow with every distinct call.
 *
 * The key is the canonical JSON of the arguments. The predecessor keyed on
 * `JSON.stringify(args, Object.keys(args).sort())`, and a replacer array
 * applies at every depth: `{ city: { name: "Berlin" } }` and
 * `{ city: { name: "Paris" } }` both serialised to `{"city":{}}` and shared
 * one cache entry. Keys are sorted at every depth here, and nothing is
 * dropped.
 */
export class ToolResultCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ToolResultCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 256;
    if (this.maxEntries < 1) throw new RangeError("maxEntries must be at least 1");
    this.now = options.now ?? Date.now;
  }

  get(name: string, args: Record<string, unknown>): ToolSuccess | undefined {
    const key = cacheKey(name, args);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-inserted so that Map order is use order, and eviction takes the oldest.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.result, cached: true, durationMs: 0 };
  }

  set(name: string, args: Record<string, unknown>, result: ToolResult): void {
    if (!result.ok) return;
    const key = cacheKey(name, args);
    this.entries.delete(key);
    this.entries.set(key, { result: { ...result, cached: false }, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `<name>:<canonical args>`. Exported so a host can key its own store the same way. */
export function cacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${canonicalJson(args)}`;
}

/**
 * JSON with object keys sorted at every depth. `undefined` values are
 * dropped the way `JSON.stringify` drops them; anything that is not JSON
 * data (a bigint, a function, a cycle) throws, as `JSON.stringify` would.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, new Set()));
}

function sortKeys(value: unknown, seen: Set<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new TypeError("cannot serialise a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
