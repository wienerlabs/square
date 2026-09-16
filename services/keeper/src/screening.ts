import { promises as dns } from "node:dns";
import { claimMarketAbi, screeningRegistryAbi, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { assertPublicUrl, classifyAddress, safeFetch, SsrfError, type HostnameLookup, type SafeFetchInit, type SafeFetchOptions } from "@squaresdk/hardening";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, zeroAddress, type Address, type PublicClient } from "viem";

export type PayeeScreeningState = "no-screening" | "cleared" | "sanctioned" | "unscreened";

export interface PayeeScreening {
  /**
   * Finalize now. True when the job's hook screens nobody, when the payee is
   * cleared, and when a fresh screening says the payee is designated: then the
   * refusal is the outcome the screening exists to produce, and holding the job
   * would only delay the client's refund.
   */
  proceed: boolean;
  state: PayeeScreeningState;
  payee?: Address;
}

/**
 * Screens the payees of a tick's jobs together. Every job asked about has an
 * entry: its screening, or the error that kept it from being read, which the
 * keeper treats as a failed attempt at that job and nothing more.
 */
export type PayeeScreenings = (jobIds: readonly bigint[]) => Promise<Map<bigint, PayeeScreening | Error>>;

/** How long one request to the screener may take, by default. */
export const DEFAULT_SCREENER_TIMEOUT_MS = 30_000;

/**
 * Addresses per request to the screener: its MAX_SUBJECTS. Each request it
 * makes to TRM carries its canary as well, and TRM refuses a request past the
 * canary and 16 addresses (services/screener/src/screen.ts).
 */
export const SCREENER_MAX_ADDRESSES = 16;

/**
 * The most of a screener's answer that is read. The keeper reads only `/health`,
 * a few hundred bytes; `/screen` is not read at all, because the registry decides.
 */
export const SCREENER_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Where the screener is. It is the operator's own service and often on a
 * private network, so `allowPrivate` lets the URL resolve to a private or
 * loopback address. A link-local address is refused either way: that is where
 * cloud metadata endpoints answer, and `@squaresdk/hardening`'s own
 * `allowPrivate` would let it through.
 */
export interface ScreenerEndpoint {
  url: string;
  allowPrivate?: boolean;
  timeoutMs?: number;
}

export interface PayeeScreeningOptions {
  client: Pick<SquareClient, "getJobRecord">;
  publicClient: Pick<PublicClient, "readContract" | "getBlock">;
  screener?: ScreenerEndpoint;
}

function scopeAllowed(address: string, allowPrivate: boolean): boolean {
  const scope = classifyAddress(address);
  return scope === "public" || (allowPrivate && (scope === "private" || scope === "loopback"));
}

function networkOf(url: string, allowPrivate: boolean): SafeFetchOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError("invalid_url", url, "not an absolute URL");
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  // Used for every name safeFetch resolves, so a name that later resolves to a
  // link-local address is refused at the connection, not only at startup.
  const lookup: HostnameLookup = async (hostname) => {
    const entries = await dns.lookup(hostname, { all: true });
    for (const entry of entries) {
      if (!scopeAllowed(entry.address, allowPrivate)) {
        throw new Error(`${hostname} resolves to ${entry.address}, which is ${classifyAddress(entry.address)}`);
      }
    }
    return entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
  };
  // The port is the one the operator configured; the address check is the guard.
  return { allowPrivate, allowedPorts: [port], lookup };
}

/** Refuses a screener URL that is not http(s), or resolves to an address it may not. */
export async function assertScreenerUrl(url: string, allowPrivate = false): Promise<void> {
  const { addresses } = await assertPublicUrl(url, networkOf(url, allowPrivate));
  for (const { address } of addresses) {
    if (!scopeAllowed(address, allowPrivate)) {
      throw new SsrfError("address_not_public", url, `${address} is ${classifyAddress(address)}, which a screener URL may not be`);
    }
  }
}

export async function screenerFetch(endpoint: ScreenerEndpoint, path: string, init: SafeFetchInit, timeoutMs?: number): Promise<Response> {
  const url = `${endpoint.url}${path}`;
  const allowPrivate = endpoint.allowPrivate ?? false;
  await assertScreenerUrl(url, allowPrivate);
  return safeFetch(url, init, {
    ...networkOf(url, allowPrivate),
    timeoutMs: timeoutMs ?? endpoint.timeoutMs ?? DEFAULT_SCREENER_TIMEOUT_MS,
    maxResponseBytes: SCREENER_MAX_RESPONSE_BYTES,
  });
}

/**
 * A whitelisted hook that is not a SquareHook has no `screening()`: the read
 * comes back with no data, or reverts. Anything else, a transport error above
 * all, says nothing about the hook.
 */
function hasNoScreeningFunction(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError || e instanceof ContractFunctionRevertedError) !== null;
}

export async function hookScreening(publicClient: Pick<PublicClient, "readContract">, hook: Address): Promise<Address | undefined> {
  if (hook === zeroAddress) return undefined;
  let registry: Address;
  try {
    registry = await publicClient.readContract({ address: hook, abi: squareHookAbi, functionName: "screening" });
  } catch (error) {
    if (hasNoScreeningFunction(error)) return undefined;
    throw error;
  }
  return registry === zeroAddress ? undefined : registry;
}

export async function assertScreenerForHook(publicClient: Pick<PublicClient, "readContract">, hook: Address): Promise<Error | undefined> {
  let registry: Address | undefined;
  try {
    registry = await hookScreening(publicClient, hook);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (registry === undefined) return undefined;
  throw new Error(
    `SCREENER_URL is not set and ${hook} screens with ${registry}: ` +
      "every release on that hook needs its payee freshly screened, so this keeper would finalize into a refusal " +
      "and pay the client instead of the provider. Set SCREENER_URL (services/screener/README.md), " +
      "or point the keeper at a hook that screens nobody.",
  );
}

interface Screened {
  registry: Address;
  payee: Address;
}

/**
 * square#35, decision §4: before a release, ask the screener for a fresh
 * screening of the payee, then let the registry decide.
 *
 * The screener's answer is not trusted here, only what reached the chain. An
 * unreachable screener leaves whatever record the registry already holds, which
 * still clears the payee if it is younger than `maxAge`. What the keeper will not
 * do is finalize a payee nobody has freshly screened: the hook would refuse the
 * release and the provider would lose a payment to an outage. It holds the job
 * instead, and the next tick asks again.
 *
 * A tick's payees are asked for together: each address once, however many jobs
 * pay it, and at most SCREENER_MAX_ADDRESSES to a request. A tick that waits on
 * a screener that does not answer waits one timeout per request, not per job.
 */
export function payeeScreening(options: PayeeScreeningOptions): PayeeScreenings {
  const { publicClient } = options;

  const whatToScreen = async (jobId: bigint): Promise<PayeeScreening | Screened> => {
    const { hook } = await options.client.getJobRecord(jobId);
    const registry = await hookScreening(publicClient, hook);
    if (registry === undefined) return { proceed: true, state: "no-screening" };
    const market = await publicClient.readContract({ address: hook, abi: squareHookAbi, functionName: "claimMarket" });
    const payee = await publicClient.readContract({ address: market, abi: claimMarketAbi, functionName: "payeeOf", args: [jobId] });
    return { registry, payee: getAddress(payee) };
  };

  const askScreener = async (screener: ScreenerEndpoint, addresses: readonly Address[]): Promise<void> => {
    try {
      const response = await screenerFetch(screener, "/screen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses }),
      });
      await response.body?.cancel();
    } catch {
      // Nothing to do: the registry below is what decides.
    }
  };

  const verdict = async ({ registry, payee }: Screened): Promise<PayeeScreening> => {
    const cleared = await publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "isCleared", args: [payee] });
    if (cleared) return { proceed: true, state: "cleared", payee };
    const [record, maxAge, latest] = await Promise.all([
      publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "screeningOf", args: [payee] }),
      publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "maxAge" }),
      publicClient.getBlock(),
    ]);
    const signerStillRegistered =
      record.screenedAt !== 0n &&
      (await publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "isScreener", args: [record.screener] }));
    const fresh = record.screenedAt !== 0n && latest.timestamp - record.screenedAt <= maxAge;
    if (record.sanctioned && fresh && signerStillRegistered) return { proceed: true, state: "sanctioned", payee };
    return { proceed: false, state: "unscreened", payee };
  };

  const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

  return async (jobIds) => {
    const outcomes = new Map<bigint, PayeeScreening | Error>();
    const toScreen = new Map<bigint, Screened>();
    for (const jobId of jobIds) {
      try {
        const found = await whatToScreen(jobId);
        if ("proceed" in found) outcomes.set(jobId, found);
        else toScreen.set(jobId, found);
      } catch (error) {
        outcomes.set(jobId, asError(error));
      }
    }
    const payees = [...new Set([...toScreen.values()].map(({ payee }) => payee))];
    const screener = options.screener;
    if (screener !== undefined) {
      for (let start = 0; start < payees.length; start += SCREENER_MAX_ADDRESSES) {
        await askScreener(screener, payees.slice(start, start + SCREENER_MAX_ADDRESSES));
      }
    }
    for (const [jobId, screened] of toScreen) {
      try {
        outcomes.set(jobId, await verdict(screened));
      } catch (error) {
        outcomes.set(jobId, asError(error));
      }
    }
    return outcomes;
  };
}
