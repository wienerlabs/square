/**
 * Finding the endpoint to send work to.
 *
 * The agent card is the source (docs/agent-card/schema.json): a resolver turns
 * a did:aip into a DID Document, the DID Document's services come from the
 * card, and the entry named A2A is where tasks go. Nothing here fetches a DID —
 * that is the resolver's job, and this package deliberately does not depend on
 * it.
 */

export interface CardService {
  name?: string;
  endpoint?: string;
  version?: string;
}

export interface AgentCardLike {
  services?: CardService[];
}

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

const A2A_SERVICE_NAME = "a2a";
const MAX_WELL_KNOWN_REDIRECTS = 3;
/** A card is a small JSON document. */
const DEFAULT_MAX_CARD_BYTES = 262_144;

/**
 * The one rule for where a task may be sent, and the one place it lives.
 *
 * The endpoint comes from the card, the card from the DID Document, and the
 * DID Document from whoever registered the agent: it is the other side's
 * choice, and two things act on it, the task POST and the request this module
 * makes by itself for the well-known card. So the rule is about the address as
 * well as the scheme:
 *
 *   - https is required. A task request carries the work and a job id, and the
 *     response is what the caller acts on; over plain http both are rewritable
 *     by anyone on the path.
 *   - A literal loopback, private, link-local or otherwise non-public address is
 *     refused whatever the scheme. TLS says nothing about where a connection
 *     goes, and a card naming https://169.254.169.254/ used to pass while
 *     http://169.254.169.254/ was refused: the address check had ended up on
 *     the unencrypted path only.
 *   - Loopback (`localhost`, `127.0.0.1`, `[::1]`) is the development
 *     exception, on http and on https both. Writing an agent means running it
 *     on localhost first, and a rule nobody can develop under is a rule people
 *     disable.
 *
 * A hostname is not resolved here: this package has no dependencies, on
 * purpose, and no access to a resolver. A name that points at a private
 * address is not caught by this check, which is why `WellKnownCache` takes a
 * `fetch`: a host that needs that guarantee passes one built on
 * `@squaresdk/hardening`'s `safeFetch`, which pins resolved addresses.
 */
function assertUsableEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointError(`A2A endpoint is not a URL: ${endpoint}`);
  }
  if (url.username || url.password) {
    throw new EndpointError(`A2A endpoint must not carry credentials: ${endpoint}`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isHttp = url.protocol === "http:";
  const isHttps = url.protocol === "https:";
  if (isLoopback(host) && (isHttp || isHttps)) return url;
  if (!isHttps) {
    throw new EndpointError(
      `A2A endpoint must be https (or http on loopback for development): ${endpoint}`,
    );
  }
  if (!isPublicHost(host)) {
    throw new EndpointError(
      `A2A endpoint must not be a private, link-local or otherwise non-public address: ${endpoint}`,
    );
  }
  return url;
}

// Address classification. A copy of the one in packages/did-resolver/src/fetch.ts,
// which is the reference; it is not imported because this package has no
// dependencies and test/no-self-settlement.test.ts keeps it that way.

type Scope = "public" | "loopback" | "private" | "link-local" | "unspecified" | "multicast" | "reserved";

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = parseIpv4(host);
  if (v4 !== null) return v4[0] === 127;
  const v6 = parseIpv6(host);
  return v6 !== null && classifyIpv6(v6) === "loopback";
}

/** True for a hostname, and for an IP literal that is globally routable. The URL parser has already canonicalised both. */
function isPublicHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const v4 = parseIpv4(host);
  if (v4 !== null) return classifyIpv4(v4) === "public";
  const v6 = parseIpv6(host);
  if (v6 !== null) return classifyIpv6(v6) === "public";
  return true;
}

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

/**
 * The A2A endpoint a card advertises.
 *
 * `name` is free-form in ERC-8004, so the match is case-insensitive and
 * trimmed. Where a card lists more than one, the first wins and the rest are
 * ignored: picking by some quality heuristic would make dispatch depend on
 * which one we guessed today.
 */
export function findA2AEndpoint(card: AgentCardLike): string {
  const services = card.services ?? [];
  const entry = services.find(
    (s) => typeof s.name === "string" && s.name.trim().toLowerCase() === A2A_SERVICE_NAME,
  );
  if (!entry) throw new EndpointError("agent card advertises no A2A service");
  if (!entry.endpoint) throw new EndpointError("the card's A2A service has no endpoint");
  assertUsableEndpoint(entry.endpoint);
  return entry.endpoint;
}

/** The card an agent serves about itself, per ERC-8004's domain verification convention. */
export function wellKnownUrlFor(endpoint: string): string {
  const url = assertUsableEndpoint(endpoint);
  return `${url.origin}/.well-known/agent-registration.json`;
}

interface CacheEntry {
  card: AgentCardLike | null;
  fetchedAt: number;
}

export interface WellKnownCacheOptions {
  ttlMs?: number;
  timeoutMs?: number;
  /** Largest card read. Default 256 KiB. */
  maxCardBytes?: number;
  /**
   * The default is the platform's fetch, which checks nothing this module does
   * not check itself: literal addresses are refused above, hostnames are not
   * resolved. A host that must not reach its own network through a card it
   * did not write passes a fetch built on `@squaresdk/hardening`'s `safeFetch`.
   */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Caches the card an endpoint serves about itself.
 *
 * A miss is cached as well as a hit. Without that, an endpoint that is down
 * gets re-fetched on every dispatch, which is the moment we can least afford
 * to spend three seconds finding out it is still down.
 *
 * What the card says is the operator's claim, not a fact: the on-chain
 * registration is authoritative for identity, and this is only ever used to
 * find a URL and read advertised capabilities.
 *
 * This is the one request the package makes on its own initiative, to an
 * origin the other side chose, so it is held to the endpoint rule at every
 * step: redirects are followed by hand, at most three, each target checked
 * like the endpoint was, and the body is read through a byte cap.
 */
export class WellKnownCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AgentCardLike | null>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxCardBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: WellKnownCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxCardBytes = options.maxCardBytes ?? DEFAULT_MAX_CARD_BYTES;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /** Cached value, or undefined when absent or stale. Never fetches. */
  peek(endpoint: string): AgentCardLike | null | undefined {
    const entry = this.entries.get(endpoint);
    if (!entry) return undefined;
    if (this.now() - entry.fetchedAt > this.ttlMs) return undefined;
    return entry.card;
  }

  /** Cached value if fresh, otherwise fetch. Concurrent calls share one request. */
  async get(endpoint: string): Promise<AgentCardLike | null> {
    const cached = this.peek(endpoint);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(endpoint);
    if (existing) return existing;

    const promise = this.load(endpoint).finally(() => this.inflight.delete(endpoint));
    this.inflight.set(endpoint, promise);
    return promise;
  }

  private async load(endpoint: string): Promise<AgentCardLike | null> {
    let card: AgentCardLike | null = null;
    try {
      const body = await this.fetchCard(wellKnownUrlFor(endpoint));
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        card = body as AgentCardLike;
      }
    } catch {
      card = null;
    }
    this.entries.set(endpoint, { card, fetchedAt: this.now() });
    return card;
  }

  /** Every hop under the endpoint rule, the body under the cap. Throws on anything else; load() turns that into a miss. */
  private async fetchCard(first: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url = first;
    for (let hop = 0; hop <= MAX_WELL_KNOWN_REDIRECTS; hop += 1) {
      assertUsableEndpoint(url);
      const res = await this.fetchImpl(url, { signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new EndpointError("redirect without a location");
        url = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) throw new EndpointError(`well-known card answered ${res.status}`);
      return JSON.parse(await readCapped(res, this.maxCardBytes));
    }
    throw new EndpointError("too many redirects to the well-known card");
  }

  clear(): void {
    this.entries.clear();
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new EndpointError(`well-known card exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new EndpointError(`well-known card exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
