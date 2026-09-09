import { AsyncLocalStorage } from "node:async_hooks";
import { createTransport, fallback, http } from "viem";
import type { EIP1193RequestFn, FallbackTransportConfig, Transport } from "viem";

export interface EndpointHealth {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  cooldownUntil: number | undefined;
  lastError: string | undefined;
  lastFailureAt: number | undefined;
  lastSuccessAt: number | undefined;
}

export interface FailoverTransportOptions {
  failureThreshold?: number | undefined;
  baseCooldownMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  timeout?: number | undefined;
  retryCount?: number | undefined;
  retryDelay?: number | undefined;
  onFailover?: ((from: string, to: string, error: Error) => void) | undefined;
  transportFactory?: ((url: string) => Transport) | undefined;
  now?: (() => number) | undefined;
  key?: string | undefined;
  name?: string | undefined;
}

export type FailoverTransport = Transport & { getHealth(): EndpointHealth[] };

export class RpcEndpointCooldownError extends Error {
  readonly url: string;
  readonly cooldownUntil: number;

  constructor(url: string, cooldownUntil: number) {
    super(`rpc endpoint ${url} is cooling down until ${new Date(cooldownUntil).toISOString()}`);
    this.name = "RpcEndpointCooldownError";
    this.url = url;
    this.cooldownUntil = cooldownUntil;
  }
}

interface EndpointState {
  url: string;
  consecutiveFailures: number;
  cooldownUntil: number | undefined;
  lastError: string | undefined;
  lastFailureAt: number | undefined;
  lastSuccessAt: number | undefined;
}

interface AttemptTrail {
  lastFailure: { url: string; error: Error } | undefined;
}

type RequestArgs = Parameters<EIP1193RequestFn>[0];
type RequestOptions = Parameters<EIP1193RequestFn>[1];

export function createFailoverTransport(
  urls: readonly string[],
  options: FailoverTransportOptions = {}
): FailoverTransport {
  if (urls.length === 0) throw new TypeError("createFailoverTransport needs at least one url");
  const now = options.now ?? Date.now;
  const failureThreshold = Math.max(1, options.failureThreshold ?? 1);
  const baseCooldownMs = options.baseCooldownMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const transportFactory =
    options.transportFactory ??
    ((url: string) => http(url, options.timeout === undefined ? {} : { timeout: options.timeout }));
  const trail = new AsyncLocalStorage<AttemptTrail>();
  const endpoints: EndpointState[] = urls.map((url) => ({
    url,
    consecutiveFailures: 0,
    cooldownUntil: undefined,
    lastError: undefined,
    lastFailureAt: undefined,
    lastSuccessAt: undefined,
  }));

  const isCoolingDown = (endpoint: EndpointState): boolean =>
    endpoint.cooldownUntil !== undefined && endpoint.cooldownUntil > now();

  const healthierEndpointFollows = (index: number): boolean =>
    endpoints.slice(index + 1).some((endpoint) => !isCoolingDown(endpoint));

  const recordSuccess = (endpoint: EndpointState): void => {
    endpoint.consecutiveFailures = 0;
    endpoint.cooldownUntil = undefined;
    endpoint.lastSuccessAt = now();
  };

  const recordFailure = (endpoint: EndpointState, error: Error): void => {
    endpoint.consecutiveFailures += 1;
    endpoint.lastError = error.message;
    endpoint.lastFailureAt = now();
    if (endpoint.consecutiveFailures < failureThreshold) return;
    const exponent = endpoint.consecutiveFailures - failureThreshold;
    endpoint.cooldownUntil = now() + Math.min(maxBackoffMs, baseCooldownMs * 2 ** exponent);
  };

  const guarded = endpoints.map((endpoint, index): Transport => {
    const upstream = transportFactory(endpoint.url);
    return (config) => {
      const inner = upstream(config);
      const request = (async (args: RequestArgs, requestOptions?: RequestOptions) => {
        const attempt = trail.getStore();
        if (isCoolingDown(endpoint) && healthierEndpointFollows(index)) {
          throw new RpcEndpointCooldownError(endpoint.url, endpoint.cooldownUntil ?? now());
        }
        if (attempt?.lastFailure !== undefined) {
          options.onFailover?.(attempt.lastFailure.url, endpoint.url, attempt.lastFailure.error);
          attempt.lastFailure = undefined;
        }
        try {
          const result: unknown = await inner.request(args, requestOptions);
          recordSuccess(endpoint);
          return result;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          recordFailure(endpoint, failure);
          if (attempt !== undefined) attempt.lastFailure = { url: endpoint.url, error: failure };
          throw error;
        }
      }) as EIP1193RequestFn;
      return createTransport(
        {
          key: `failover-endpoint-${index}`,
          name: endpoint.url,
          request,
          retryCount: 0,
          timeout: config.timeout,
          type: "failoverEndpoint",
        },
        { url: endpoint.url }
      );
    };
  });

  const fallbackConfig: FallbackTransportConfig = {
    key: options.key ?? "failover",
    name: options.name ?? "Failover",
  };
  if (options.retryCount !== undefined) fallbackConfig.retryCount = options.retryCount;
  if (options.retryDelay !== undefined) fallbackConfig.retryDelay = options.retryDelay;
  const chain = fallback(guarded, fallbackConfig);

  const transport: Transport = (config) => {
    const inner = chain(config);
    const request = ((args: RequestArgs, requestOptions?: RequestOptions) =>
      trail.run({ lastFailure: undefined }, () => inner.request(args, requestOptions))) as EIP1193RequestFn;
    return { ...inner, request };
  };

  const getHealth = (): EndpointHealth[] =>
    endpoints.map((endpoint) => ({
      url: endpoint.url,
      healthy: !isCoolingDown(endpoint),
      consecutiveFailures: endpoint.consecutiveFailures,
      cooldownUntil: isCoolingDown(endpoint) ? endpoint.cooldownUntil : undefined,
      lastError: endpoint.lastError,
      lastFailureAt: endpoint.lastFailureAt,
      lastSuccessAt: endpoint.lastSuccessAt,
    }));

  return Object.assign(transport, { getHealth });
}

export interface RpcRetryOptions {
  attempts?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  isRetryable?: ((error: unknown) => boolean) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PERMANENT_JSON_RPC_CODES = new Set([-32600, -32601, -32602, -32603]);
const EXECUTION_REVERTED = /execution reverted/i;
const MAX_CAUSE_DEPTH = 8;

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (chain.length < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function jsonRpcCode(candidate: unknown): number | undefined {
  const code = (candidate as { code?: unknown }).code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && /^-?\d+$/.test(code)) return Number(code);
  return undefined;
}

export function isPermanentRpcError(error: unknown): boolean {
  for (const link of causeChain(error)) {
    const code = jsonRpcCode(link);
    if (code !== undefined && PERMANENT_JSON_RPC_CODES.has(code)) return true;
    const message = (link as { message?: unknown }).message;
    if (typeof message === "string" && EXECUTION_REVERTED.test(message)) return true;
  }
  return false;
}

const defaultIsRetryable = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "AbortError") return false;
  return !isPermanentRpcError(error);
};

async function sleepUntilElapsedOrAborted(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal === undefined) {
    await sleep(ms);
    return false;
  }
  if (signal.aborted) return true;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(() => resolve(false), reject);
    });
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export function jitteredBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export async function withRpcRetry<T>(fn: (attempt: number) => Promise<T>, options: RpcRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  options.signal?.throwIfAborted();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || options.signal?.aborted || !isRetryable(error)) throw error;
      const delayMs = jitteredBackoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      if (await sleepUntilElapsedOrAborted(sleep, delayMs, options.signal)) throw error;
    }
  }
}
