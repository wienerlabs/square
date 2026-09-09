import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { canonicalJson } from "./canonicalJson.js";
import { msFromTimestamp } from "./sql.js";
import type { SqlClient } from "./sql.js";

export interface RequestFingerprint {
  method: string;
  path: string;
  body?: unknown;
  actor?: string | null | undefined;
}

export function hashRequest(request: RequestFingerprint): string {
  const canonical = canonicalJson({
    actor: request.actor ?? null,
    body: request.body === undefined ? null : request.body,
    method: request.method.toUpperCase(),
    path: request.path,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export interface StoredResponse {
  requestHash: string;
  status: number;
  body: unknown;
  expiresAt: number;
}

export type PutIfAbsentResult = { status: "stored" } | { status: "exists"; stored: StoredResponse };

export interface IdempotencyStore {
  get(scope: string, key: string): Promise<StoredResponse | undefined>;
  putIfAbsent(
    scope: string,
    key: string,
    requestHash: string,
    response: HandlerResponse,
    ttlMs: number
  ): Promise<PutIfAbsentResult>;
}

export interface StoreClockOptions {
  now?: (() => number) | undefined;
}

function entryId(scope: string, key: string): string {
  return `${scope.length}:${scope}:${key}`;
}

export function idempotencyScope(scope: string, actor: string): string {
  return `${scope.length}:${scope}:${actor}`;
}

export function memoryIdempotencyStore(options: StoreClockOptions = {}): IdempotencyStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, StoredResponse>();
  const live = (scope: string, key: string): StoredResponse | undefined => {
    const id = entryId(scope, key);
    const entry = entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(id);
      return undefined;
    }
    return entry;
  };
  return {
    async get(scope, key) {
      return live(scope, key);
    },
    async putIfAbsent(scope, key, requestHash, response, ttlMs) {
      const existing = live(scope, key);
      if (existing !== undefined) return { status: "exists", stored: existing };
      entries.set(entryId(scope, key), {
        requestHash,
        status: response.status,
        body: response.body,
        expiresAt: now() + ttlMs,
      });
      return { status: "stored" };
    },
  };
}

const IDEMPOTENCY_CLAIM_SQL = `insert into idempotency_keys (scope, key, request_hash, status, response, created_at, expires_at)
values ($1, $2, decode($3, 'hex'), $4, $5::jsonb, now(), $6::timestamptz)
on conflict (scope, key) do update
set request_hash = excluded.request_hash,
    status = excluded.status,
    response = excluded.response,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at
where idempotency_keys.expires_at <= now()
returning key`;

const IDEMPOTENCY_READ_SQL = `select request_hash, status, response, expires_at
from idempotency_keys
where scope = $1 and key = $2 and expires_at > now()`;

function hexFromBytea(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string") return value.startsWith("\\x") ? value.slice(2) : value;
  throw new TypeError("request_hash column is neither bytes nor text");
}

function jsonFromColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function storedFromRow(row: Record<string, unknown>): StoredResponse {
  return {
    requestHash: hexFromBytea(row["request_hash"]),
    status: Number(row["status"]),
    body: jsonFromColumn(row["response"]),
    expiresAt: msFromTimestamp(row["expires_at"]),
  };
}

export function postgresIdempotencyStore(db: SqlClient, options: StoreClockOptions = {}): IdempotencyStore {
  const now = options.now ?? Date.now;
  return {
    async get(scope, key) {
      const result = await db.query(IDEMPOTENCY_READ_SQL, [scope, key]);
      const row = result.rows[0];
      return row === undefined ? undefined : storedFromRow(row);
    },
    async putIfAbsent(scope, key, requestHash, response, ttlMs) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const claimed = await db.query(IDEMPOTENCY_CLAIM_SQL, [
          scope,
          key,
          requestHash,
          response.status,
          JSON.stringify(response.body ?? null),
          new Date(now() + ttlMs).toISOString(),
        ]);
        if (claimed.rows.length > 0) return { status: "stored" };
        const existing = await db.query(IDEMPOTENCY_READ_SQL, [scope, key]);
        const row = existing.rows[0];
        if (row !== undefined) return { status: "exists", stored: storedFromRow(row) };
      }
      throw new Error(`idempotency key ${scope}/${key} expired between claim and read twice in a row`);
    },
  };
}

export interface IdempotencyRequest {
  scope: string;
  key: string;
  requestHash: string;
}

export type IdempotentOutcome =
  | { source: "handler"; status: number; body: unknown }
  | { source: "replay"; status: number; body: unknown }
  | { source: "conflict"; status: 409; body: { error: "idempotency_key_reused" } };

export interface WithIdempotencyOptions {
  ttlMs?: number | undefined;
  shouldStore?: ((response: HandlerResponse) => boolean) | undefined;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function conflictOutcome(): IdempotentOutcome {
  return { source: "conflict", status: 409, body: { error: "idempotency_key_reused" } };
}

function outcomeFromStored(stored: StoredResponse, requestHash: string): IdempotentOutcome {
  if (stored.requestHash !== requestHash) return conflictOutcome();
  return { source: "replay", status: stored.status, body: stored.body };
}

export function withIdempotency<Input extends IdempotencyRequest>(
  store: IdempotencyStore,
  handler: (input: Input) => Promise<HandlerResponse>,
  options: WithIdempotencyOptions = {}
): (input: Input) => Promise<IdempotentOutcome> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const shouldStore = options.shouldStore ?? ((response: HandlerResponse) => response.status < 500);
  const inFlight = new Map<string, Promise<IdempotentOutcome>>();
  const execute = async (input: Input): Promise<IdempotentOutcome> => {
    const id = entryId(input.scope, input.key);
    const running = inFlight.get(id);
    if (running !== undefined) {
      await running.catch(() => undefined);
      return execute(input);
    }
    const run = (async (): Promise<IdempotentOutcome> => {
      const existing = await store.get(input.scope, input.key);
      if (existing !== undefined) return outcomeFromStored(existing, input.requestHash);
      const response = await handler(input);
      if (!shouldStore(response)) return { source: "handler", status: response.status, body: response.body };
      const put = await store.putIfAbsent(input.scope, input.key, input.requestHash, response, ttlMs);
      if (put.status === "exists") return outcomeFromStored(put.stored, input.requestHash);
      return { source: "handler", status: response.status, body: response.body };
    })();
    inFlight.set(id, run);
    try {
      return await run;
    } finally {
      inFlight.delete(id);
    }
  };
  return execute;
}

export interface IdempotencyMiddlewareOptions {
  scope: string;
  actorOf: (c: Context) => string | undefined;
  header?: string | undefined;
  ttlMs?: number | undefined;
  required?: boolean | undefined;
  methods?: readonly string[] | undefined;
}

interface CapturedBody {
  contentType: string | null;
  text: string;
}

interface MiddlewareInput extends IdempotencyRequest {
  respond: () => Promise<HandlerResponse>;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function pathWithQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function parsedRequestBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text === "") return null;
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function captureBody(response: Response): Promise<CapturedBody> {
  return { contentType: response.headers.get("content-type"), text: await response.clone().text() };
}

function asCapturedBody(body: unknown): CapturedBody {
  if (typeof body === "object" && body !== null && typeof (body as CapturedBody).text === "string") {
    const contentType = (body as CapturedBody).contentType;
    return { contentType: typeof contentType === "string" ? contentType : null, text: (body as CapturedBody).text };
  }
  return { contentType: "application/json", text: JSON.stringify(body ?? null) };
}

function replayResponse(outcome: Exclude<IdempotentOutcome, { source: "handler" }>): Response {
  if (outcome.source === "conflict") {
    return new Response(JSON.stringify(outcome.body), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  const captured = asCapturedBody(outcome.body);
  const headers = new Headers({ "idempotent-replayed": "true" });
  if (captured.contentType !== null) headers.set("content-type", captured.contentType);
  const body = NULL_BODY_STATUSES.has(outcome.status) || captured.text === "" ? null : captured.text;
  return new Response(body, { status: outcome.status, headers });
}

export function idempotencyMiddleware(
  store: IdempotencyStore,
  options: IdempotencyMiddlewareOptions
): MiddlewareHandler {
  const header = options.header ?? "Idempotency-Key";
  const methods = new Set(
    (options.methods ?? ["POST", "PUT", "PATCH", "DELETE"]).map((method) => method.toUpperCase())
  );
  const execute = withIdempotency<MiddlewareInput>(store, (input) => input.respond(), { ttlMs: options.ttlMs });
  return async (c, next) => {
    if (!methods.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const key = c.req.header(header);
    if (key === undefined || key === "") {
      if (options.required) return c.json({ error: "idempotency_key_required" }, 400);
      await next();
      return;
    }
    const actor = options.actorOf(c);
    if (actor === undefined || actor === "") {
      return c.json({ error: "idempotency_actor_unknown" }, 400);
    }
    const requestHash = hashRequest({
      method: c.req.method,
      path: pathWithQuery(c.req.url),
      body: await parsedRequestBody(c),
      actor,
    });
    const outcome = await execute({
      scope: idempotencyScope(options.scope, actor),
      key,
      requestHash,
      respond: async () => {
        await next();
        return { status: c.res.status, body: await captureBody(c.res) };
      },
    });
    if (outcome.source === "handler") return;
    return replayResponse(outcome);
  };
}
