const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const DEFAULT_TIMEOUT_MS = 10_000;
/** A registration file is a small JSON document. A megabyte is generous; more is not a card. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;

/**
 * Why a fetch failed, without saying where. The message never carries the
 * URL, the host or the HTTP status: the resolver turns these errors into
 * `didResolutionMetadata.warnings`, which go back to whoever asked, and an
 * agentURI is chosen by whoever registered the agent. A message that said
 * "HTTP 403 from https://10.0.0.5/" would let anyone probe the network the
 * resolver runs in by registering an agent and resolving it.
 */
export type AgentUriErrorCode =
  | "unsupportedScheme"
  | "malformedUri"
  | "credentialsInUrl"
  | "hostNotPublic"
  | "hostNotAllowed"
  | "tooManyRedirects"
  | "redirectWithoutLocation"
  | "timeout"
  | "unreachable"
  | "httpError"
  | "tooLarge"
  | "notJson";

export class AgentUriError extends Error {
  readonly code: AgentUriErrorCode;
  /**
   * The status behind an `httpError`, and the network stack's own words
   * behind an `unreachable`, both kept off the message. A caller that owns
   * the URI (the CLI checking a card before registering it) may show them; a
   * resolver answering strangers must not, because "connection refused" and
   * "name not found" tell an outsider different things about the inside.
   */
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(code: AgentUriErrorCode, message: string, extra: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = "AgentUriError";
    this.code = code;
    this.status = extra.status;
    this.detail = extra.detail;
  }
}

export interface FetchAgentUriOptions {
  /** Where `ipfs://` is read through. Default `https://ipfs.io/ipfs/`. */
  ipfsGateway?: string;
  /** For the whole fetch, redirects included. Default 10 s. */
  timeoutMs?: number;
  /** Refuse a registration file larger than this. Default 1 MiB. */
  maxResponseBytes?: number;
  /**
   * Hosts an agentURI may point at, applied to every redirect hop. Omit to
   * accept any public host. The configured IPFS gateway is exempt: it is the
   * operator's choice, not the agent's.
   */
  allowedHosts?: string[];
  /** Injectable for tests. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Dereference an agentURI.
 *
 * ERC-8004 allows ipfs://, https:// and data: URIs. http:// is refused: the
 * registration file decides what a consumer believes about an agent, and
 * fetching it over a channel anyone can rewrite makes that belief worthless.
 *
 * The URI is chosen by the agent's owner and this runs in a public service (the
 * Universal Resolver driver), so it is treated as hostile input all the way
 * down, not only at the scheme:
 *
 *   - Redirects are followed by hand, and every hop is held to the same rule as
 *     the first. `redirect: "follow"` would have taken an https URL to a plain
 *     http one on a single 302, because mixed-content blocking is a browser
 *     policy and not part of fetch.
 *   - A literal loopback, private, link-local or otherwise non-public address
 *     is refused before any connection is made, in IPv4, IPv6 and the mapped,
 *     NAT64 and 6to4 forms that embed an IPv4 address. A hostname is not
 *     resolved here (this module runs in browsers as well as in Node), so a
 *     name that points at a private address is not caught; a deployment that
 *     needs that guarantee runs the driver behind an egress policy or injects
 *     a `fetchAgentUri` built on `@squaresdk/hardening`, whose `safeFetch`
 *     pins resolved addresses. That package is not used here because it
 *     carries `undici` and `@squaresdk/data`, and this package is a dependency
 *     of the browser app and the CLI.
 *   - The body is read through a byte cap, declared length first and then the
 *     stream itself, because the timeout bounds seconds and not bytes.
 *   - An `ipfs://` remainder must be a CID followed by plain path segments, and
 *     the URL it builds must stay under the gateway's own path. Anything else
 *     could walk out of `/ipfs/` on an operator's private gateway.
 *   - Errors say why and never where; see `AgentUriError`.
 */
export async function defaultFetchAgentUri(
  uri: string,
  opts: FetchAgentUriOptions = {}
): Promise<unknown> {
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  if (uri.startsWith("data:")) return parseDataUri(uri, maxBytes);

  let first: URL;
  let viaGateway = false;
  if (uri.startsWith("ipfs://")) {
    first = ipfsUrl(uri, opts.ipfsGateway ?? DEFAULT_IPFS_GATEWAY);
    viaGateway = true;
  } else if (uri.startsWith("https://")) {
    first = parseUrl(uri);
  } else {
    throw new AgentUriError(
      "unsupportedScheme",
      "unsupported agentURI scheme (https, ipfs and data are supported; http is refused)"
    );
  }

  // The gateway is the operator's choice, not the agent's, so it is taken as
  // configured: https anywhere, or http on loopback so that a card can be read
  // through a local node before anything is deployed (the exception the A2A
  // discovery rules make, for the same reason). A local node answers with
  // redirects of its own, to a subdomain of localhost, so while the gateway
  // is on loopback every loopback hop is tolerated too. Where a gateway on
  // the public internet sends us gets the full check, like any other hop.
  const policy: HopPolicy = {
    gateway: viaGateway,
    loopbackDev: viaGateway && isLoopback(hostOf(first)),
    allowedHosts: opts.allowedHosts,
  };

  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let url = first;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertAllowedUrl(url, { ...policy, gateway: policy.gateway && hop === 0 });

      let res: Response;
      try {
        res = await doFetch(url.toString(), { signal: ctrl.signal, redirect: "manual" });
      } catch (err) {
        if (ctrl.signal.aborted) throw new AgentUriError("timeout", "the registration file did not arrive in time");
        throw new AgentUriError("unreachable", "could not connect to the registration file's host", { detail: describe(err) });
      }

      if (isRedirect(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new AgentUriError("redirectWithoutLocation", "a redirect carried no location");
        url = parseUrl(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AgentUriError("httpError", "the registration file's host answered with an error status", { status: res.status });
      }
      return await readJson(res, maxBytes, ctrl.signal);
    }
    throw new AgentUriError("tooManyRedirects", `more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The network stack's own words, for `AgentUriError.detail`; never for the message. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // undici wraps the cause; the useful part is one level down.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return cause ? `${message} (${cause})` : message;
}

function parseUrl(raw: string, base?: URL): URL {
  try {
    return new URL(raw, base);
  } catch {
    throw new AgentUriError("malformedUri", "the agentURI is not a valid URL");
  }
}

const CID = /^[A-Za-z0-9]+$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * `ipfs://<cid>[/<segment>...]`, optionally with a legacy `ipfs/` prefix,
 * appended to the gateway. Every multibase alphabet is alphanumeric, so a CID
 * has no dots, slashes or percent signs to smuggle a `..` through, and a path
 * segment may not be one. After building the URL the gateway's own path is
 * checked to still be a prefix, so that the guarantee does not depend on the
 * two rules above alone.
 */
function ipfsUrl(uri: string, gateway: string): URL {
  const rest = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  const [cid, ...segments] = rest.split("/");
  const wellFormed =
    cid !== undefined &&
    CID.test(cid) &&
    segments.every((s) => PATH_SEGMENT.test(s) && s !== "." && s !== "..");
  if (!wellFormed) {
    throw new AgentUriError("malformedUri", "an ipfs:// agentURI must be a CID, optionally followed by plain path segments");
  }

  let base: URL;
  try {
    base = new URL(gateway);
  } catch {
    throw new AgentUriError("malformedUri", "the IPFS gateway is not a valid URL");
  }
  const built = parseUrl(gateway + rest);
  if (built.origin !== base.origin || !built.pathname.startsWith(base.pathname)) {
    throw new AgentUriError("malformedUri", "an ipfs:// agentURI must stay under the gateway's path");
  }
  return built;
}

interface HopPolicy {
  /** This hop is the configured IPFS gateway itself. */
  gateway: boolean;
  /** The configured gateway is on loopback, so this is a development machine. */
  loopbackDev: boolean;
  allowedHosts: string[] | undefined;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function assertAllowedUrl(url: URL, policy: HopPolicy): void {
  if (url.username || url.password) {
    throw new AgentUriError("credentialsInUrl", "the agentURI carries credentials");
  }
  const host = hostOf(url);
  const isHttp = url.protocol === "http:";
  if (policy.gateway) {
    if (url.protocol === "https:" || (isHttp && isLoopback(host))) return;
    throw new AgentUriError("unsupportedScheme", "the IPFS gateway must be https, or http on loopback");
  }
  if (policy.loopbackDev && isLoopback(host) && (isHttp || url.protocol === "https:")) return;
  if (url.protocol !== "https:") {
    throw new AgentUriError(
      "unsupportedScheme",
      "only https is fetched, including after a redirect; http is refused because anyone on the path can rewrite it"
    );
  }
  if (!isPublicHost(host)) {
    throw new AgentUriError("hostNotPublic", "the agentURI points at a loopback, private or otherwise non-public address");
  }
  if (policy.allowedHosts && !policy.allowedHosts.some((h) => h.toLowerCase().replace(/\.$/, "") === host)) {
    throw new AgentUriError("hostNotAllowed", "the agentURI's host is not in this resolver's allowlist");
  }
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = parseIpv4(host);
  if (v4 !== null) return v4[0] === 127;
  const v6 = parseIpv6(host);
  return v6 !== null && classifyIpv6(v6) === "loopback";
}

/**
 * True for a hostname, and for an IP literal that is globally routable. The
 * URL parser has already canonicalised IPv4 (octal, hex, decimal and short
 * forms all arrive as a dotted quad) and IPv6 (bracketed, compressed).
 */
function isPublicHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const v4 = parseIpv4(host);
  if (v4 !== null) return classifyIpv4(v4) === "public";
  const v6 = parseIpv6(host);
  if (v6 !== null) return classifyIpv6(v6) === "public";
  return true;
}

type Scope = "public" | "loopback" | "private" | "link-local" | "unspecified" | "multicast" | "reserved";

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return parts.every((p) => p <= 255) ? parts : null;
}

function classifyIpv4([a, b, c]: [number, number, number, number]): Scope {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

/** Eight 16-bit groups, or null. Accepts the bracketed form the URL parser produces. */
function parseIpv6(host: string): number[] | null {
  const text = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function classifyIpv6(g: number[]): Scope {
  const embedded = (hi: number, lo: number): [number, number, number, number] =>
    [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyIpv4(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyIpv4(embedded(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return classifyIpv4(embedded(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // ULA
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  return "public";
}

async function readJson(res: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new AgentUriError("tooLarge", `the registration file exceeds ${maxBytes} bytes`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new AgentUriError("tooLarge", `the registration file exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof AgentUriError) throw err;
      if (signal.aborted) throw new AgentUriError("timeout", "the registration file did not arrive in time");
      throw new AgentUriError("unreachable", "the registration file's body could not be read", { detail: describe(err) });
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJson(new TextDecoder().decode(bytes));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentUriError("notJson", "the registration file is not valid JSON");
  }
}

/** Decoded in-process, so the only failures are the payload's own. */
function parseDataUri(uri: string, maxBytes: number): unknown {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new AgentUriError("malformedUri", "a data: agentURI needs a comma before its payload");
  const meta = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);

  let text: string;
  try {
    if (meta.includes(";base64")) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      if (bytes.byteLength > maxBytes) throw new AgentUriError("tooLarge", `the registration file exceeds ${maxBytes} bytes`);
      text = new TextDecoder().decode(bytes);
    } else {
      text = decodeURIComponent(payload);
    }
  } catch (err) {
    if (err instanceof AgentUriError) throw err;
    throw new AgentUriError("malformedUri", "the data: payload is not valid base64 or percent-encoding");
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AgentUriError("tooLarge", `the registration file exceeds ${maxBytes} bytes`);
  }
  return parseJson(text);
}
