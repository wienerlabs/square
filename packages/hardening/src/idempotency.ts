import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { idempotencyKeys, type Database, type Json } from "@squaresdk/data";
import { canonicalJson } from "./canonicalJson.js";
import { isTransientRejection, TRANSIENT_REJECTION_STATUSES } from "./transient.js";

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
  transient?: boolean | undefined;
}

export function defaultShouldStore(response: HandlerResponse): boolean {
  return response.status < 500 && !TRANSIENT_REJECTION_STATUSES.has(response.status);
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

function jsonBody(body: unknown): Json {
  return (body ?? null) as Json;
}

function storedFromRecord(record: idempotencyKeys.IdempotencyRecord): StoredResponse {
  return {
    requestHash: record.requestHash.slice(2),
    status: record.status,
    body: record.response,
    expiresAt: record.expiresAt.getTime(),
  };
}

export function postgresIdempotencyStore(db: Database): IdempotencyStore {
  return {
    async get(scope, key) {
      const record = await idempotencyKeys.get(db, scope, key);
      return record === null ? undefined : storedFromRecord(record);
    },
    async putIfAbsent(scope, key, requestHash, response, ttlMs) {
      const claim = await idempotencyKeys.putIfAbsent(db, {
        scope,
        key,
        requestHash: `0x${requestHash}`,
        status: response.status,
        response: jsonBody(response.body),
        ttlMs,
      });
      return claim.outcome === "stored" ? { status: "stored" } : { status: "exists", stored: storedFromRecord(claim.record) };
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
  const shouldStore = options.shouldStore ?? defaultShouldStore;
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
      if (response.transient === true || !shouldStore(response)) {
        return { source: "handler", status: response.status, body: response.body };
      }
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
  shouldStore?: ((response: HandlerResponse) => boolean) | undefined;
  required?: boolean | undefined;
  methods?: readonly string[] | undefined;
}

interface CapturedResponse {
  headers: [string, string][];
  text: string;
}

const REGENERATED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface MiddlewareInput extends IdempotencyRequest {
  respond: () => Promise<HandlerResponse>;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function canonicalQuery(search: string): string {
  const entries = [...new URLSearchParams(search)].sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName === rightName ? compareStrings(leftValue, rightValue) : compareStrings(leftName, rightName)
  );
  return new URLSearchParams(entries).toString();
}

export function pathWithCanonicalQuery(url: string): string {
  const parsed = new URL(url);
  const query = canonicalQuery(parsed.search);
  return query === "" ? parsed.pathname : `${parsed.pathname}?${query}`;
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

function setCookies(headers: Headers): string[] {
  const readAll = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof readAll === "function") return readAll.call(headers);
  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function replayableHeaders(headers: Headers): [string, string][] {
  const captured: [string, string][] = [];
  headers.forEach((value, name) => {
    const lowercased = name.toLowerCase();
    if (lowercased === "set-cookie" || REGENERATED_HEADERS.has(lowercased)) return;
    captured.push([lowercased, value]);
  });
  for (const cookie of setCookies(headers)) captured.push(["set-cookie", cookie]);
  return captured;
}

async function captureResponse(response: Response): Promise<CapturedResponse> {
  return { headers: replayableHeaders(response.headers), text: await response.clone().text() };
}

function isHeaderPair(entry: unknown): entry is [string, string] {
  return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string";
}

function storedHeaders(stored: { headers?: unknown; contentType?: unknown }): [string, string][] {
  if (Array.isArray(stored.headers)) {
    return stored.headers.filter(isHeaderPair).map(([name, value]): [string, string] => [name.toLowerCase(), value]);
  }
  return typeof stored.contentType === "string" ? [["content-type", stored.contentType]] : [];
}

function asCapturedResponse(body: unknown): CapturedResponse {
  if (typeof body === "object" && body !== null && typeof (body as CapturedResponse).text === "string") {
    const stored = body as { headers?: unknown; contentType?: unknown; text: string };
    return { headers: storedHeaders(stored), text: stored.text };
  }
  return { headers: [["content-type", "application/json"]], text: JSON.stringify(body ?? null) };
}

function replayResponse(outcome: Exclude<IdempotentOutcome, { source: "handler" }>): Response {
  if (outcome.source === "conflict") {
    return new Response(JSON.stringify(outcome.body), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  const captured = asCapturedResponse(outcome.body);
  const headers = new Headers();
  for (const [name, value] of captured.headers) headers.append(name, value);
  headers.set("idempotent-replayed", "true");
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
  const execute = withIdempotency<MiddlewareInput>(store, (input) => input.respond(), {
    ttlMs: options.ttlMs,
    shouldStore: options.shouldStore,
  });
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
      path: pathWithCanonicalQuery(c.req.url),
      body: await parsedRequestBody(c),
      actor,
    });
    const outcome = await execute({
      scope: idempotencyScope(options.scope, actor),
      key,
      requestHash,
      respond: async () => {
        await next();
        return { status: c.res.status, body: await captureResponse(c.res), transient: isTransientRejection(c) };
      },
    });
    if (outcome.source === "handler") return;
    return replayResponse(outcome);
  };
}
