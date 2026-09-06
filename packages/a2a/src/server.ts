import {
  RpcErrorCode,
  rpcError,
  rpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type TaskCancelParams,
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
 */

/** Runs the actual work. Resolving means delivered; throwing means failed. */
export type CapabilityHandler = (task: {
  taskId: string;
  capability: string;
  input: string;
  callerDid: string;
  jobId: string;
}) => Promise<string>;

export interface A2AServerOptions {
  /** capability id -> handler. A capability that is not here is refused, not guessed. */
  handlers: Record<string, CapabilityHandler>;
  machine?: TaskMachine;
  /** Concurrent tasks this provider will run. Beyond it, callers get a retryable Busy. */
  maxConcurrent?: number;
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
  private running = 0;

  constructor(options: A2AServerOptions) {
    this.machine = options.machine ?? new TaskMachine();
    this.handlers = options.handlers;
    this.maxConcurrent = options.maxConcurrent ?? 5;
  }

  capabilities(): string[] {
    return Object.keys(this.handlers);
  }

  /** Parsed JSON-RPC request in, JSON-RPC response out. Never throws. */
  async handle(request: unknown): Promise<JsonRpcResponse> {
    if (typeof request !== "object" || request === null) {
      return rpcError("", RpcErrorCode.InvalidRequest, "request is not an object");
    }
    const req = request as Partial<JsonRpcRequest>;
    const id = typeof req.id === "string" ? req.id : "";
    if (req.jsonrpc !== "2.0") {
      return rpcError(id, RpcErrorCode.InvalidRequest, "jsonrpc must be \"2.0\"");
    }
    const params = (req.params ?? {}) as Record<string, unknown>;

    switch (req.method) {
      case "task/create":
        return this.create(id, params);
      case "task/status":
        return this.status(id, params as unknown as TaskStatusParams);
      case "task/cancel":
        return this.cancel(id, params as unknown as TaskCancelParams);
      default:
        return rpcError(id, RpcErrorCode.MethodNotFound, `unknown method: ${String(req.method)}`);
    }
  }

  private create(id: string, raw: Record<string, unknown>): JsonRpcResponse {
    for (const field of REQUIRED_CREATE_FIELDS) {
      if (typeof raw[field] !== "string" || !(raw[field] as string)) {
        return rpcError(id, RpcErrorCode.InvalidParams, `missing or empty ${field}`);
      }
    }
    const params = raw as unknown as TaskCreateParams;

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
    try {
      const deliverable = await handler({
        taskId,
        capability: params.capability,
        input: params.input,
        callerDid: params.callerDid,
        jobId: params.jobId,
      });
      this.machine.deliver(taskId, deliverable);
    } catch (err) {
      try {
        this.machine.fail(taskId, err instanceof Error ? err.message : String(err));
      } catch {
        /* already terminal — cancelled while the handler was running */
      }
    } finally {
      this.running -= 1;
    }
  }

  private status(id: string, params: TaskStatusParams): JsonRpcResponse {
    if (typeof params.taskId !== "string" || !params.taskId) {
      return rpcError(id, RpcErrorCode.InvalidParams, "missing taskId");
    }
    const task = this.machine.get(params.taskId);
    if (!task) return rpcError(id, RpcErrorCode.TaskNotFound, `no such task: ${params.taskId}`);
    return rpcResult(id, {
      taskId: task.id,
      state: task.state,
      ...(task.deliverable !== undefined ? { deliverable: task.deliverable } : {}),
      ...(task.reason !== undefined ? { reason: task.reason } : {}),
      updatedAt: task.updatedAt,
    });
  }

  private cancel(id: string, params: TaskCancelParams): JsonRpcResponse {
    if (typeof params.taskId !== "string" || !params.taskId) {
      return rpcError(id, RpcErrorCode.InvalidParams, "missing taskId");
    }
    try {
      const task = this.machine.cancel(params.taskId);
      return rpcResult(id, { taskId: task.id, state: task.state });
    } catch (err) {
      const message = err instanceof TaskTransitionError ? err.message : String(err);
      return rpcError(id, RpcErrorCode.InvalidParams, message);
    }
  }
}
