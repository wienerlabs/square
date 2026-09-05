const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export class AgentUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUriError";
  }
}

/**
 * Dereference an agentURI.
 *
 * ERC-8004 allows ipfs://, https:// and data: URIs. http:// is refused: the
 * registration file decides what a consumer believes about an agent, and
 * fetching it over a channel anyone can rewrite makes that belief worthless.
 */
export async function defaultFetchAgentUri(
  uri: string,
  opts: { ipfsGateway?: string; timeoutMs?: number } = {}
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new AgentUriError("malformed data: URI");
    const meta = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    const text = meta.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return JSON.parse(text);
  }

  let url: string;
  if (uri.startsWith("ipfs://")) {
    const gateway = opts.ipfsGateway ?? DEFAULT_IPFS_GATEWAY;
    url = gateway + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  } else if (uri.startsWith("https://")) {
    url = uri;
  } else {
    throw new AgentUriError(
      `unsupported agentURI scheme: ${uri.slice(0, 16)} (https, ipfs and data are supported; http is refused)`
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new AgentUriError(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    if (err instanceof AgentUriError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentUriError(`could not dereference ${uri}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
