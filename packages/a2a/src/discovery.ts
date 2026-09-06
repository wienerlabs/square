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

/**
 * Reject anything that is not https, with one exception for loopback.
 *
 * A task request carries the work and a job id, and the response is what the
 * caller will act on. Over plain http both are rewritable by anyone on the
 * path. The loopback exception exists because writing an agent means running it
 * on localhost first, and a rule nobody can develop under is a rule people
 * disable.
 */
function assertUsableEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointError(`A2A endpoint is not a URL: ${endpoint}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")) {
    return url;
  }
  throw new EndpointError(
    `A2A endpoint must be https (or http on loopback for development): ${endpoint}`,
  );
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
 */
export class WellKnownCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AgentCardLike | null>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: WellKnownCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
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
      const res = await this.fetchImpl(wellKnownUrlFor(endpoint), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          card = body as AgentCardLike;
        }
      }
    } catch {
      card = null;
    }
    this.entries.set(endpoint, { card, fetchedAt: this.now() });
    return card;
  }

  clear(): void {
    this.entries.clear();
  }
}
