import {
  isJsonRpcResponse,
  rpcRequest,
  type JsonRpcResponse,
  type TaskCancelResult,
  type TaskCreateParams,
  type TaskCreateResult,
  type TaskMethod,
  type TaskStatusResult,
} from "./messages.js";
import { TaskState, isTerminalTaskState } from "./states.js";

/**
 * The caller's side of the protocol.
 *
 * Carried over from the predecessor: retry with exponential backoff on 429 and
 * 5xx only, a per-endpoint concurrency cap, and separate timeouts for dispatch
 * and polling. Left behind: the hard-coded branches that recognised the
 * product's own hosted-agent and web-search URLs and called into them
 * in-process. A protocol client that knows the names of three specific
 * endpoints is not a protocol client.
 */

export class A2AError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unreachable"
      | "timeout"
      | "provider-error"
      | "protocol-error"
      | "busy"
      | "at-capacity",
    readonly status?: number,
  ) {
    super(message);
    this.name = "A2AError";
  }
}

export interface A2AClientOptions {
  /** Concurrent tasks per endpoint. The cap protects the provider, not us. */
  maxConcurrentPerEndpoint?: number;
  /** Timeout for task/create and task/cancel. */
  dispatchTimeoutMs?: number;
  /** Timeout for a single task/status poll. Shorter: it runs in a loop. */
  pollTimeoutMs?: number;
  maxRetries?: number;
  /** Base for exponential backoff; attempt n waits `backoffMs * 2^n`. */
  backoffMs?: number;
  /** Injectable for tests and for callers with their own agent/proxy. */
  fetch?: typeof globalThis.fetch;
  /** Injectable so tests do not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxConcurrentPerEndpoint: 5,
  dispatchTimeoutMs: 10_000,
  pollTimeoutMs: 5_000,
  maxRetries: 3,
  backoffMs: 1_000,
};

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;

export class A2AClient {
  private readonly active = new Map<string, number>();
  private readonly opts: Required<Omit<A2AClientOptions, "fetch" | "sleep">> & {
    fetch: typeof globalThis.fetch;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(options: A2AClientOptions = {}) {
    this.opts = {
      ...DEFAULTS,
      ...options,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  // takeSlot / freeSlot rather than acquire / release. "Release" in this
  // codebase means releasing escrow to a provider, and a concurrency helper
  // that borrows the word is one careless read away from looking like one.
  private takeSlot(endpoint: string): boolean {
    const current = this.active.get(endpoint) ?? 0;
    if (current >= this.opts.maxConcurrentPerEndpoint) return false;
    this.active.set(endpoint, current + 1);
    return true;
  }

  private freeSlot(endpoint: string): void {
    const current = this.active.get(endpoint) ?? 0;
    if (current <= 1) this.active.delete(endpoint);
    else this.active.set(endpoint, current - 1);
  }

  /** Visible for tests and for a caller that wants to show queue depth. */
  inFlight(endpoint: string): number {
    return this.active.get(endpoint) ?? 0;
  }

  private async rpc<R>(
    endpoint: string,
    method: TaskMethod,
    params: Record<string, unknown>,
    timeoutMs: number,
    retries: number,
  ): Promise<R> {
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      const body = JSON.stringify(rpcRequest(method, params));
      let res: Response;
      try {
        res = await this.opts.fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // AbortSignal.timeout aborts with a TimeoutError; anything else here is
        // DNS, TLS or a refused connection. Both are worth retrying, and they
        // are worth telling apart in the message.
        const timedOut = (err as { name?: string }).name === "TimeoutError";
        if (attempt < retries - 1) {
          await this.opts.sleep(this.opts.backoffMs * 2 ** attempt);
          continue;
        }
        throw new A2AError(
          timedOut
            ? `${endpoint} did not respond within ${timeoutMs}ms`
            : `${endpoint} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
          timedOut ? "timeout" : "unreachable",
        );
      }

      if (res.ok) {
        let payload: unknown;
        try {
          payload = await res.json();
        } catch {
          throw new A2AError(`${endpoint} returned a 200 that is not JSON`, "protocol-error", 200);
        }
        if (!isJsonRpcResponse(payload)) {
          throw new A2AError(`${endpoint} returned a 200 that is not a JSON-RPC response`, "protocol-error", 200);
        }
        const rpc = payload as JsonRpcResponse<R>;
        if (rpc.error) {
          throw new A2AError(`${method} rejected: ${rpc.error.message}`, "provider-error");
        }
        if (rpc.result === undefined) {
          throw new A2AError(`${method} returned neither a result nor an error`, "protocol-error");
        }
        return rpc.result;
      }

      lastStatus = res.status;
      if (!RETRYABLE_STATUS(res.status)) {
        throw new A2AError(`${endpoint} returned ${res.status} for ${method}`, "provider-error", res.status);
      }

      if (attempt < retries - 1) {
        // A provider that says how long to wait knows better than our curve.
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.opts.backoffMs * 2 ** attempt;
        await this.opts.sleep(wait);
        continue;
      }
    }

    throw new A2AError(
      lastStatus === 429
        ? `${endpoint} is busy (429 after ${retries} attempts)`
        : `${endpoint} failed after ${retries} attempts`,
      lastStatus === 429 ? "busy" : "provider-error",
      lastStatus,
    );
  }

  async createTask(endpoint: string, params: TaskCreateParams): Promise<TaskCreateResult> {
    return this.rpc<TaskCreateResult>(
      endpoint,
      "task/create",
      params as unknown as Record<string, unknown>,
      this.opts.dispatchTimeoutMs,
      this.opts.maxRetries,
    );
  }

  /** One poll. Not retried: the polling loop is the retry. */
  async taskStatus(endpoint: string, taskId: string): Promise<TaskStatusResult> {
    return this.rpc<TaskStatusResult>(endpoint, "task/status", { taskId }, this.opts.pollTimeoutMs, 1);
  }

  async cancelTask(endpoint: string, taskId: string): Promise<TaskCancelResult> {
    return this.rpc<TaskCancelResult>(
      endpoint,
      "task/cancel",
      { taskId },
      this.opts.dispatchTimeoutMs,
      1,
    );
  }

  /**
   * Dispatch and poll until the provider reaches a terminal state.
   *
   * Returns whatever the provider ended on, including FAILED. It does not throw
   * for a failed task, because a provider that could not do the work has
   * answered the question — and the caller's next move (wait for the evaluator,
   * or let the job expire) is the same either way.
   */
  async runTask(
    endpoint: string,
    params: TaskCreateParams,
    opts: { pollIntervalMs?: number; maxPolls?: number; signal?: AbortSignal } = {},
  ): Promise<TaskStatusResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 500;
    const maxPolls = opts.maxPolls ?? 60;

    if (!this.takeSlot(endpoint)) {
      throw new A2AError(
        `${endpoint} already has ${this.opts.maxConcurrentPerEndpoint} tasks in flight from this client`,
        "at-capacity",
      );
    }

    try {
      const created = await this.createTask(endpoint, params);

      for (let i = 0; i < maxPolls; i += 1) {
        if (opts.signal?.aborted) throw new A2AError("task polling was aborted", "timeout");
        await this.opts.sleep(pollIntervalMs);
        const status = await this.taskStatus(endpoint, created.taskId);
        if (isTerminalTaskState(status.state)) return status;
      }

      throw new A2AError(
        `${endpoint} did not finish ${created.taskId} within ${maxPolls} polls`,
        "timeout",
      );
    } finally {
      this.freeSlot(endpoint);
    }
  }
}
