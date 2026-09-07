import { promises as dns } from "node:dns";
import type { LookupOptions } from "node:dns";
import { isIP, isIPv4, isIPv6 } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";

export type SsrfRejectionCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "port_not_allowed"
  | "invalid_host"
  | "address_not_public"
  | "dns_lookup_failed"
  | "no_addresses"
  | "redirect_follow_not_allowed"
  | "too_many_redirects"
  | "body_not_replayable"
  | "response_too_large"
  | "timeout";

export class SsrfError extends Error {
  readonly code: SsrfRejectionCode;
  readonly url: string;

  constructor(code: SsrfRejectionCode, url: string, detail: string) {
    super(`${detail} [${code}] ${url}`);
    this.name = "SsrfError";
    this.code = code;
    this.url = url;
  }
}

export type AddressScope =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "reserved"
  | "invalid";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostnameLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PublicUrlOptions {
  allowedPorts?: readonly number[] | undefined;
  allowPrivate?: boolean | undefined;
  lookup?: HostnameLookup | undefined;
}

export interface SafeFetchOptions extends PublicUrlOptions {
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

export interface FollowRedirectsOptions extends SafeFetchOptions {
  maxRedirects?: number | undefined;
}

export type SafeFetchInit = Omit<UndiciRequestInit, "dispatcher" | "redirect"> & {
  redirect?: "manual" | "error" | undefined;
};

export interface ValidatedUrl {
  url: URL;
  hostname: string;
  port: number;
  addresses: ResolvedAddress[];
}

const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DECIMAL_PART = /^[0-9]+$/;
const HEX_PART = /^0[xX][0-9a-fA-F]*$/;
const OCTAL_PART = /^0[0-7]+$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitHostParts(host: string): string[] {
  const parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function parseIpv4Part(part: string): number | undefined {
  if (HEX_PART.test(part)) return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  if (OCTAL_PART.test(part)) return Number.parseInt(part, 8);
  if (DECIMAL_PART.test(part)) return Number.parseInt(part, 10);
  return undefined;
}

export function parseIpv4Literal(host: string): number | undefined {
  const parts = splitHostParts(host);
  if (parts.length === 0 || parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === undefined) return undefined;
    values.push(value);
  }
  const tail = values.pop();
  if (tail === undefined) return undefined;
  if (tail >= 256 ** (4 - values.length)) return undefined;
  if (values.some((value) => value > 255)) return undefined;
  return values.reduce((sum, value, index) => sum + value * 256 ** (3 - index), tail);
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function endsInNumber(host: string): boolean {
  const parts = splitHostParts(host);
  const last = parts[parts.length - 1];
  return last !== undefined && last !== "" && (DECIMAL_PART.test(last) || HEX_PART.test(last));
}

function parseDottedQuad(text: string): number | undefined {
  if (!isIPv4(text)) return undefined;
  return text.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function parseHexGroups(segment: string): number[] | undefined {
  if (segment === "") return [];
  const pieces = segment.split(":");
  const groups: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.includes(".")) {
      if (index !== pieces.length - 1) return undefined;
      const quad = parseDottedQuad(piece);
      if (quad === undefined) return undefined;
      groups.push(quad >>> 16, quad & 0xffff);
      continue;
    }
    if (!HEX_GROUP.test(piece)) return undefined;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}

export function parseIpv6Literal(text: string): number[] | undefined {
  const zoneStart = text.indexOf("%");
  const literal = zoneStart === -1 ? text : text.slice(0, zoneStart);
  if (!isIPv6(literal)) return undefined;
  const gap = literal.indexOf("::");
  const head = parseHexGroups(gap === -1 ? literal : literal.slice(0, gap));
  const tail = parseHexGroups(gap === -1 ? "" : literal.slice(gap + 2));
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (gap === -1 ? missing !== 0 : missing < 0) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

interface Ipv4Range {
  prefix: number;
  bits: number;
  scope: AddressScope;
}

function ipv4Range(address: string, bits: number, scope: AddressScope): Ipv4Range {
  return { prefix: parseDottedQuad(address) ?? 0, bits, scope };
}

const IPV4_RANGES: readonly Ipv4Range[] = [
  ipv4Range("0.0.0.0", 8, "unspecified"),
  ipv4Range("10.0.0.0", 8, "private"),
  ipv4Range("100.64.0.0", 10, "private"),
  ipv4Range("127.0.0.0", 8, "loopback"),
  ipv4Range("169.254.0.0", 16, "link_local"),
  ipv4Range("172.16.0.0", 12, "private"),
  ipv4Range("192.0.0.0", 24, "reserved"),
  ipv4Range("192.0.2.0", 24, "reserved"),
  ipv4Range("192.88.99.0", 24, "reserved"),
  ipv4Range("192.168.0.0", 16, "private"),
  ipv4Range("198.18.0.0", 15, "reserved"),
  ipv4Range("198.51.100.0", 24, "reserved"),
  ipv4Range("203.0.113.0", 24, "reserved"),
  ipv4Range("224.0.0.0", 4, "multicast"),
  ipv4Range("240.0.0.0", 4, "reserved"),
];

function classifyIpv4(value: number): AddressScope {
  for (const range of IPV4_RANGES) {
    const shift = 32 - range.bits;
    if (value >>> shift === range.prefix >>> shift) return range.scope;
  }
  return "public";
}

function embeddedIpv4(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

function classifyIpv6(words: readonly number[]): AddressScope {
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const leadingZeros = (count: number): boolean => words.slice(0, count).every((word) => word === 0);
  if (leadingZeros(8)) return "unspecified";
  if (leadingZeros(7) && w7 === 1) return "loopback";
  if (leadingZeros(5) && w5 === 0xffff) return classifyIpv4(embeddedIpv4(w6, w7));
  if (leadingZeros(6)) return classifyIpv4(embeddedIpv4(w6, w7));
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return classifyIpv4(embeddedIpv4(w6, w7));
  }
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0x0001) return "private";
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return "reserved";
  if (w0 === 0x2001 && w1 === 0) {
    const teredoServer = classifyIpv4(embeddedIpv4(w2, w3));
    if (teredoServer !== "public") return teredoServer;
    return classifyIpv4(embeddedIpv4(w6 ^ 0xffff, w7 ^ 0xffff));
  }
  if (w0 === 0x2001 && w1 === 0x0002 && w2 === 0) return "reserved";
  if (w0 === 0x2001 && w1 === 0x0db8) return "reserved";
  if (w0 === 0x2002) return classifyIpv4(embeddedIpv4(w1, w2));
  if ((w0 & 0xfe00) === 0xfc00) return "private";
  if ((w0 & 0xffc0) === 0xfe80) return "link_local";
  if ((w0 & 0xffc0) === 0xfec0) return "private";
  if ((w0 & 0xff00) === 0xff00) return "multicast";
  if ((w0 & 0xfff0) === 0x3ff0) return "reserved";
  return "public";
}

export function classifyAddress(address: string): AddressScope {
  const family = isIP(address);
  if (family === 4) {
    const value = parseDottedQuad(address);
    return value === undefined ? "invalid" : classifyIpv4(value);
  }
  if (family === 6) {
    const words = parseIpv6Literal(address);
    return words === undefined ? "invalid" : classifyIpv6(words);
  }
  return "invalid";
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === "public";
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackName(hostname: string): boolean {
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return name === "localhost" || name.endsWith(".localhost");
}

function literalAddress(hostname: string, url: string): ResolvedAddress | undefined {
  if (isIPv6(hostname)) return { address: hostname, family: 6 };
  const ipv4 = parseIpv4Literal(hostname);
  if (ipv4 !== undefined) return { address: formatIpv4(ipv4), family: 4 };
  if (endsInNumber(hostname)) {
    throw new SsrfError("invalid_host", url, `${hostname} looks like an IPv4 literal but does not parse as one`);
  }
  return undefined;
}

const systemLookup: HostnameLookup = async (hostname) => {
  const entries = await dns.lookup(hostname, { all: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

async function resolveHostname(hostname: string, url: string, lookup: HostnameLookup): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    throw new SsrfError("dns_lookup_failed", url, `could not resolve ${hostname}: ${describe(error)}`);
  }
  if (addresses.length === 0) throw new SsrfError("no_addresses", url, `${hostname} resolved to no addresses`);
  return addresses;
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new SsrfError("invalid_url", url, "not an absolute URL");
  }
}

export async function assertPublicUrl(url: string, options: PublicUrlOptions = {}): Promise<ValidatedUrl> {
  const parsed = parseUrl(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError("unsupported_scheme", url, `${parsed.protocol} is not http or https`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SsrfError("credentials_in_url", url, "userinfo in the URL is not allowed");
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.includes(port)) {
    throw new SsrfError("port_not_allowed", url, `port ${port} is outside the allowlist ${allowedPorts.join(",")}`);
  }
  const hostname = stripBrackets(parsed.hostname);
  if (hostname === "") throw new SsrfError("invalid_host", url, "empty host");
  if (!options.allowPrivate && isLoopbackName(hostname)) {
    throw new SsrfError("address_not_public", url, `${hostname} is a loopback name`);
  }
  const literal = literalAddress(hostname, url);
  const addresses =
    literal === undefined ? await resolveHostname(hostname, url, options.lookup ?? systemLookup) : [literal];
  for (const entry of addresses) {
    const scope = classifyAddress(entry.address);
    if (scope === "invalid") throw new SsrfError("invalid_host", url, `${entry.address} is not an IP address`);
    if (scope !== "public" && !options.allowPrivate) {
      throw new SsrfError("address_not_public", url, `${hostname} resolves to ${entry.address} which is ${scope}`);
    }
  }
  return { url: parsed, hostname, port, addresses };
}

function requestedFamily(options: LookupOptions): 0 | 4 | 6 {
  if (options.family === 4 || options.family === "IPv4") return 4;
  if (options.family === 6 || options.family === "IPv6") return 6;
  return 0;
}

export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = requestedFamily(options);
    const matching = family === 0 ? [...addresses] : addresses.filter((entry) => entry.family === family);
    const first = matching[0];
    process.nextTick(() => {
      if (first === undefined) {
        callback(Object.assign(new Error(`no pinned address for family ${family}`), { code: "ENOTFOUND" }), []);
        return;
      }
      if (options.all) {
        callback(
          null,
          matching.map((entry) => ({ address: entry.address, family: entry.family }))
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function byteCap(maxBytes: number, url: string): TransformStream<Uint8Array, Uint8Array> {
  let received = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        controller.error(new SsrfError("response_too_large", url, `response body exceeded ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export async function safeFetch(url: string, init: SafeFetchInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  if ((init as { redirect?: string }).redirect === "follow") {
    throw new SsrfError(
      "redirect_follow_not_allowed",
      url,
      "safeFetch never follows redirects, use safeFetchFollowingRedirects"
    );
  }
  const validated = await assertPublicUrl(url, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const agent = new Agent({
    connect: { lookup: createPinnedLookup(validated.addresses), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let upstream;
  try {
    upstream = await undiciFetch(validated.url, {
      ...init,
      dispatcher: agent,
      redirect: init.redirect ?? "manual",
      signal,
    });
  } catch (error) {
    await agent.close();
    if (timeoutSignal.aborted) throw new SsrfError("timeout", url, `no response within ${timeoutMs}ms`);
    throw error;
  }
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await upstream.body?.cancel();
    await agent.close();
    throw new SsrfError(
      "response_too_large",
      url,
      `declared content-length ${declaredLength} exceeds ${maxResponseBytes} bytes`
    );
  }
  agent.close().catch(() => undefined);
  const upstreamBody = upstream.body as unknown as ReadableStream<Uint8Array> | null;
  const body =
    upstreamBody === null || NULL_BODY_STATUSES.has(upstream.status)
      ? null
      : upstreamBody.pipeThrough(byteCap(maxResponseBytes, url));
  const response = new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: Array.from(upstream.headers),
  });
  Object.defineProperty(response, "url", { value: validated.url.href, enumerable: true });
  return response;
}

function headerPairs(headers: SafeFetchInit["headers"]): Array<[string, string]> {
  if (headers === undefined || headers === null) return [];
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function") {
    return Array.from(headers as Iterable<readonly string[]>).map((pair) => [pair[0] ?? "", pair[1] ?? ""]);
  }
  return Object.entries(headers as Record<string, string | readonly string[]>).map(([name, value]) => [
    name,
    Array.isArray(value) ? value.join(", ") : String(value),
  ]);
}

function isReplayableBody(body: unknown): boolean {
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return false;
}

function redirectedInit(init: SafeFetchInit, status: number, fromUrl: string, toUrl: string): SafeFetchInit {
  const method = (init.method ?? "GET").toUpperCase();
  const dropBody = status === 303 || ((status === 301 || status === 302) && method === "POST");
  const crossOrigin = new URL(fromUrl).origin !== new URL(toUrl).origin;
  const headers = headerPairs(init.headers).filter(([name]) => {
    const lower = name.toLowerCase();
    if (dropBody && (lower === "content-type" || lower === "content-length" || lower === "content-encoding")) {
      return false;
    }
    if (crossOrigin && (lower === "authorization" || lower === "proxy-authorization" || lower === "cookie")) {
      return false;
    }
    return true;
  });
  if (dropBody) return { ...init, method: "GET", body: null, headers };
  if (init.body !== undefined && init.body !== null && !isReplayableBody(init.body)) {
    throw new SsrfError(
      "body_not_replayable",
      toUrl,
      `status ${status} requires resending a body that can only be read once`
    );
  }
  return { ...init, headers };
}

function resolveRedirectTarget(from: string, location: string): string {
  try {
    return new URL(location, from).href;
  } catch {
    throw new SsrfError("invalid_url", location, "redirect target is not a valid URL");
  }
}

export async function safeFetchFollowingRedirects(
  url: string,
  init: SafeFetchInit = {},
  options: FollowRedirectsOptions = {}
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;
  let currentInit: SafeFetchInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop += 1) {
    const response = await safeFetch(currentUrl, currentInit, options);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel();
    if (hop >= maxRedirects) {
      throw new SsrfError("too_many_redirects", currentUrl, `exceeded ${maxRedirects} redirects`);
    }
    const nextUrl = resolveRedirectTarget(currentUrl, location);
    currentInit = redirectedInit(currentInit, response.status, currentUrl, nextUrl);
    currentUrl = nextUrl;
  }
}
