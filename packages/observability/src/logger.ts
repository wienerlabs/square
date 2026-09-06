export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSink = (line: string) => void;

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  service: string;
  version: string;
  level?: LogLevel;
  sink?: LogSink;
  allowlist?: Iterable<string>;
  maxStringLength?: number;
  clock?: () => number;
}

export interface Logger {
  readonly level: LogLevel;
  readonly allowlist: ReadonlySet<string>;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface RedactOptions {
  allowlist?: Iterable<string>;
  maxStringLength?: number;
}

export interface RedactResult {
  fields: Record<string, unknown>;
  dropped: number;
}

export const DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
  "jobId",
  "chainId",
  "txHash",
  "blockNumber",
  "elapsedMs",
  "error",
  "status",
  "count",
  "reason",
  "endpoint",
  "attempt",
  "agentId",
  "keeper",
  "gasUsed",
  "fee",
  "age",
  "rule",
  "outcome",
]);

export const RESERVED_KEYS: readonly string[] = Object.freeze([
  "ts",
  "level",
  "service",
  "version",
  "event",
  "dropped_fields",
  "truncated",
]);

export const MAX_STRING_LENGTH = 2048;

const RESERVED: ReadonlySet<string> = new Set(RESERVED_KEYS);
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 256;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const EMPTY: RedactResult = { fields: {}, dropped: 0 };

interface Sanitized {
  keep: boolean;
  value: unknown;
  dropped: number;
  truncated: boolean;
}

const OMITTED: Sanitized = { keep: false, value: undefined, dropped: 0, truncated: false };
const DROPPED: Sanitized = { keep: false, value: undefined, dropped: 1, truncated: false };

function kept(value: unknown, truncated = false): Sanitized {
  return { keep: true, value, dropped: 0, truncated };
}

function cut(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: text.slice(0, maxLength), truncated: true };
}

function serializeError(error: Error, maxLength: number, depth: number): Record<string, unknown> {
  const message = cut(String(error.message), maxLength);
  const out: Record<string, unknown> = { name: String(error.name), message: message.text };
  let truncated = message.truncated;
  if (typeof error.stack === "string") {
    const stack = cut(error.stack, maxLength);
    out.stack = stack.text;
    truncated = truncated || stack.truncated;
  }
  if (error.cause instanceof Error && depth < MAX_DEPTH) {
    out.cause = serializeError(error.cause, maxLength, depth + 1);
  }
  if (truncated) out.truncated = true;
  return out;
}

function sanitizeArray(
  items: readonly unknown[],
  allow: ReadonlySet<string>,
  maxLength: number,
  depth: number,
): Sanitized {
  const out: unknown[] = [];
  let dropped = 0;
  let truncated = items.length > MAX_ARRAY_LENGTH;
  const limit = Math.min(items.length, MAX_ARRAY_LENGTH);
  for (let i = 0; i < limit; i += 1) {
    const item = sanitize(items[i], allow, maxLength, depth + 1);
    dropped += item.dropped;
    if (!item.keep) {
      if (items[i] === undefined) out.push(null);
      continue;
    }
    if (item.truncated) truncated = true;
    out.push(item.value);
  }
  return { keep: true, value: out, dropped, truncated };
}

function sanitize(raw: unknown, allow: ReadonlySet<string>, maxLength: number, depth: number): Sanitized {
  if (raw === null) return kept(null);
  switch (typeof raw) {
    case "string": {
      const text = cut(raw, maxLength);
      return kept(text.text, text.truncated);
    }
    case "number":
    case "boolean":
      return kept(raw);
    case "bigint":
      return kept(raw >= MIN_SAFE && raw <= MAX_SAFE ? Number(raw) : raw.toString());
    case "undefined":
      return OMITTED;
    case "function":
    case "symbol":
      return DROPPED;
    default:
      break;
  }
  if (raw instanceof Date) return kept(Number.isNaN(raw.getTime()) ? null : raw.toISOString());
  if (raw instanceof Error) return kept(serializeError(raw, maxLength, depth));
  if (depth >= MAX_DEPTH) return DROPPED;
  if (Array.isArray(raw)) return sanitizeArray(raw, allow, maxLength, depth);
  const nested = filterObject(raw as Record<string, unknown>, allow, maxLength, depth);
  return { keep: true, value: nested.fields, dropped: nested.dropped, truncated: false };
}

function filterObject(
  input: Record<string, unknown>,
  allow: ReadonlySet<string>,
  maxLength: number,
  depth: number,
): RedactResult {
  const fields: Record<string, unknown> = {};
  let dropped = 0;
  let truncated = false;
  for (const key of Object.keys(input)) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (RESERVED.has(key) || !allow.has(key)) {
      dropped += 1;
      continue;
    }
    const item = sanitize(raw, allow, maxLength, depth + 1);
    dropped += item.dropped;
    if (!item.keep) continue;
    if (item.truncated) truncated = true;
    fields[key] = item.value;
  }
  if (truncated) fields.truncated = true;
  return { fields, dropped };
}

function buildAllowlist(extra?: Iterable<string>): ReadonlySet<string> {
  const allow = new Set(DEFAULT_ALLOWLIST);
  if (extra !== undefined) {
    for (const key of extra) allow.add(key);
  }
  return allow;
}

export function redact(fields: LogFields, options: RedactOptions = {}): RedactResult {
  return filterObject(fields, buildAllowlist(options.allowlist), options.maxStringLength ?? MAX_STRING_LENGTH, 0);
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function emit(sink: LogSink, line: string): void {
  try {
    sink(line);
  } catch {
    return;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, version } = options;
  const level = options.level ?? "info";
  const threshold = LEVEL_RANK[level];
  const allow = buildAllowlist(options.allowlist);
  const maxLength = options.maxStringLength ?? MAX_STRING_LENGTH;
  const clock = options.clock ?? Date.now;
  const sink = options.sink ?? defaultSink;

  function build(bindings: RedactResult): Logger {
    function write(lineLevel: LogLevel, event: string, fields?: LogFields): void {
      if (LEVEL_RANK[lineLevel] < threshold) return;
      const own = fields === undefined ? EMPTY : filterObject(fields, allow, maxLength, 0);
      const head = {
        ts: new Date(clock()).toISOString(),
        level: lineLevel,
        service,
        version,
        event: cut(String(event), maxLength).text,
      };
      const dropped = bindings.dropped + own.dropped;
      const line: Record<string, unknown> = { ...head, ...bindings.fields, ...own.fields };
      if (dropped > 0) line.dropped_fields = dropped;
      let serialized: string;
      try {
        serialized = JSON.stringify(line);
      } catch {
        const fieldCount = Object.keys(bindings.fields).length + Object.keys(own.fields).length;
        serialized = JSON.stringify({ ...head, dropped_fields: dropped + fieldCount });
      }
      emit(sink, serialized);
    }

    return {
      level,
      allowlist: allow,
      debug: (event, fields) => write("debug", event, fields),
      info: (event, fields) => write("info", event, fields),
      warn: (event, fields) => write("warn", event, fields),
      error: (event, fields) => write("error", event, fields),
      child: (extra) => {
        const more = filterObject(extra, allow, maxLength, 0);
        return build({
          fields: { ...bindings.fields, ...more.fields },
          dropped: bindings.dropped + more.dropped,
        });
      },
    };
  }

  return build(EMPTY);
}
