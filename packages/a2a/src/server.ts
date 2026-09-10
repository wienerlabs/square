import {
  RpcErrorCode,
  rpcError,
  rpcResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type TaskCreateParams,
  type TaskStatusParams,
} from "./messages.js";
import { TaskState } from "./states.js";
import { TaskMachine, TaskTransitionError, type TaskRecord } from "./task-machine.js";

/**
 * The provider's side of the protocol.
 *
 * Framework-free on purpose: it takes a parsed request and returns a response,
 * so the same handler sits behind node:http, Express, a Worker or a test
 * without any of them leaking in. Reading the body and writing the status is
 * the host's job.
 *
 * What it will not do is settle. `task/complete` is not a method, because
 * completion is not the provider's to declare — the provider delivers, and the
 * work of turning that into money belongs to the evaluator.
 *
 * Nor is `task/cancel`. `create` acknowledges before it returns, so no caller
 * ever sees a task SUBMITTED, and SUBMITTED is the only state a cancel is
 * allowed from. `TaskMachine.cancel` stays for a host that holds the machine
 * itself and chooses to accept later; over this wire the method would have
 * been an error with a name.
 */

/**
 * Runs the actual work. Resolving means delivered; throwing means failed.
 *
 * `signal` aborts when the task is timed out (`handlerTimeoutMs`). A handler
 * that keeps going after it is not counted against the provider any more and
 * cannot deliver: the task is already FAILED.
 */
export type CapabilityHandler = (task: {
  taskId: string;
  capability: string;
  input: string;
  callerDid: string;
  jobId: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface A2AServerOptions {
  /** capability id -> handler. A capability that is not here is refused, not guessed. */
  handlers: Record<string, CapabilityHandler>;
  machine?: TaskMachine;
  /** Concurrent tasks this provider will run. Beyond it, callers get a retryable Busy. */
  maxConcurrent?: number;
  /**
   * Longest a handler may run. When it passes, the task FAILS with a reason
   * that says so, the handler's signal aborts, and the concurrency slot is
   * given back. Without it a handler that never settles holds its slot for
   * the life of the process, and five of those turn every honest caller away
   * with Busy.
   */
  handlerTimeoutMs?: number;
}

/**
 * What the host knows about the caller, from outside the request body.
 *
 * The body's `callerDid` is a claim. This package has no wire-level identity
 * (no signatures, no sessions: that is the host's transport, and
 * `@squaresdk/hardening`'s signed messages are one way to get it), so the
 * host that has authenticated the caller says so here, and the server holds
 * the body to it: a `task/create` whose `callerDid` is not the authenticated
 * one is refused, and a task is visible only to the caller that created it.
 * With no context the body is taken at its word, which is only acceptable
 * behind a host that authenticates by other means or does not care who asks.
 */
export interface CallContext {
  callerDid?: string;
}

const REQUIRED_CREATE_FIELDS: readonly (keyof TaskCreateParams)[] = [
  "taskId",
  "capability",
  "input",
  "callerDid",
  "jobId",
];

export class A2AServer {
  readonly machine: TaskMachine;
  private readonly handlers: Record<string, CapabilityHandler>;
  private readonly maxConcurrent: number;
  private readonly handlerTimeoutMs: number | undefined;
  private running = 0;

  constructor(options: A2AServerOptions) {
    this.machine = options.machine ?? new TaskMachine();
    this.handlers = options.handlers;
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.handlerTimeoutMs = options.handlerTimeoutMs;
  }

  capabilities(): string[] {
    return Object.keys(this.handlers);
  }

  /** Tasks running right now. Visible so a host can watch the slots it hands out. */
  get inFlight(): number {
    return this.running;
  }

  /** Parsed JSON-RPC request in, JSON-RPC response out. Never throws. */
  async handle(request: unknown, context: CallContext = {}): Promise<JsonRpcResponse> {
    if (typeof request !== "object" || request === null) {
      return rpcError(null, RpcErrorCode.InvalidRequest, "request is not an object");
    }
    const req = request as Partial<JsonRpcRequest>;
    // Echoed as received. JSON-RPC 2.0 lets it be a string, a number or null,
    // and asks for null when the request did not carry a usable one.
    const id: JsonRpcId = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
    if (req.jsonrpc !== "2.0") {
      return rpcError(id, RpcErrorCode.InvalidRequest, "jsonrpc must be \"2.0\"");
    }
    const params = (req.params ?? {}) as Record<string, unknown>;

    switch (req.method) {
      case "task/create":
        return this.create(id, params, context);
      case "task/status":
        return this.status(id, params as unknown as TaskStatusParams, context);
      default:
        return rpcError(id, RpcErrorCode.MethodNotFound, `unknown method: ${String(req.method)}`);
    }
  }

  private create(id: JsonRpcId, raw: Record<string, unknown>, context: CallContext): JsonRpcResponse {
    for (const field of REQUIRED_CREATE_FIELDS) {
      if (typeof raw[field] !== "string" || !(raw[field] as string)) {
        return rpcError(id, RpcErrorCode.InvalidParams, `missing or empty ${field}`);
      }
    }
    const params = raw as unknown as TaskCreateParams;

    if (context.callerDid !== undefined && params.callerDid !== context.callerDid) {
      return rpcError(id, RpcErrorCode.InvalidParams, "callerDid does not match the authenticated caller");
    }

    // Idempotent on taskId. The client retries task/create, and the response
    // to a request that created and started the task can be lost on the way
    // back; the retry then carries the same five fields and must not be told
    // "id already used" as if it were a bad request. It gets the task as it
    // stands. Different content under the same id is a different matter.
    const existing = this.machine.get(params.taskId);
    if (existing) {
      const same =
        existing.capability === params.capability &&
        existing.input === params.input &&
        existing.callerDid === params.callerDid &&
        existing.jobId === params.jobId;
      if (!same) return rpcError(id, RpcErrorCode.TaskIdInUse, `taskId ${params.taskId} is already in use for a different task`);
      return rpcResult(id, { taskId: existing.id, state: existing.state, acceptedAt: existing.updatedAt });
    }

    const handler = this.handlers[params.capability];
    if (!handler) {
      return rpcError(
        id,
        RpcErrorCode.CapabilityNotOffered,
        `this agent does not offer ${params.capability}`,
      );
    }
    if (this.running >= this.maxConcurrent) {
      return rpcError(id, RpcErrorCode.Busy, "at capacity; retry shortly");
    }

    let task: TaskRecord;
    try {
      task = this.machine.create({
        id: params.taskId,
        capability: params.capability,
        input: params.input,
        callerDid: params.callerDid,
        jobId: params.jobId,
      });
      this.machine.accept(task.id);
    } catch (err) {
      const message = err instanceof TaskTransitionError ? err.message : String(err);
      return rpcError(id, RpcErrorCode.InvalidParams, message);
    }

    // Deliberately not awaited: task/create acknowledges, and the caller polls.
    // Errors are folded into the task's own state, so nothing escapes here.
    void this.run(task.id, handler, params);

    return rpcResult(id, {
      taskId: task.id,
      state: TaskState.Working,
      acceptedAt: task.updatedAt,
    });
  }

  private async run(taskId: string, handler: CapabilityHandler, params: TaskCreateParams): Promise<void> {
    this.running += 1;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = handler({
        taskId,
        capability: params.capability,
        input: params.input,
        callerDid: params.callerDid,
        jobId: params.jobId,
        signal: ctrl.signal,
      });
      // The race is what gives the slot back: the counter is this class's
      // own, nothing outside can reconcile it, so it must not wait on a
      // promise that might never settle.
      const deadline =
        this.handlerTimeoutMs === undefined
          ? undefined
          : new Promise<never>((_resolve, expire) => {
              timer = setTimeout(() => {
                ctrl.abort();
                expire(new Error(`handler timed out after ${this.handlerTimeoutMs}ms`));
              }, this.handlerTimeoutMs);
            });
      const deliverable = deadline === undefined ? await work : await Promise.race([work, deadline]);
      this.machine.deliver(taskId, deliverable);
    } catch (err) {
      try {
        this.machine.fail(taskId, err instanceof Error ? err.message : String(err));
      } catch {
        /* already terminal: a host that shares the machine failed it from outside while the handler ran */
      }
    } finally {
      clearTimeout(timer);
      this.running -= 1;
    }
  }

  private status(id: JsonRpcId, params: TaskStatusParams, context: CallContext): JsonRpcResponse {
    if (typeof params.taskId !== "string" || !params.taskId) {
      return rpcError(id, RpcErrorCode.InvalidParams, "missing taskId");
    }
    const task = this.machine.get(params.taskId);
    // Another caller's task is answered exactly like a missing one. A task id
    // is chosen by its caller, and telling a stranger which ids exist is a
    // small leak with no use to an honest one.
    if (!task || (context.callerDid !== undefined && task.callerDid !== context.callerDid)) {
      return rpcError(id, RpcErrorCode.TaskNotFound, `no such task: ${params.taskId}`);
    }
    return rpcResult(id, {
      taskId: task.id,
      state: task.state,
      ...(task.deliverable !== undefined ? { deliverable: task.deliverable } : {}),
      ...(task.reason !== undefined ? { reason: task.reason } : {}),
      updatedAt: task.updatedAt,
    });
  }
}
