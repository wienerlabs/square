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
import type { TaskSettlement } from "./settlement.js";
import { JOB_STATUS_NAMES, TaskState } from "./states.js";
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
 * What it resolves with depends on how the server was composed. Without a
 * settlement the value is the deliverable itself, the reference that
 * DELIVERED carries. With one, it is the delivered content: the settlement
 * hashes it, puts the hash on chain with `submit`, and DELIVERED carries
 * what went on chain.
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
  /**
   * How tasks reach the chain. With it, `task/create` refuses a job the chain
   * does not show as funded for this provider, DELIVERED is produced by the
   * on-chain `submit`, and `task/status` reports the job's status as the chain
   * has it. Without it the server is the pure protocol, as before.
   */
  settlement?: TaskSettlement;
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
  private readonly settlement: TaskSettlement | undefined;
  private running = 0;

  constructor(options: A2AServerOptions) {
    this.machine = options.machine ?? new TaskMachine();
    this.handlers = options.handlers;
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.handlerTimeoutMs = options.handlerTimeoutMs;
    this.settlement = options.settlement;
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

  private async create(id: JsonRpcId, raw: Record<string, unknown>, context: CallContext): Promise<JsonRpcResponse> {
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

    // The chain's say, before any work is done. A job that is not Funded, or
    // is funded for another provider, gets no handler run: the work would be
    // unpaid, and the provider's one on-chain action, submit, would revert at
    // the end of it. Asked after the cheap refusals above, so a request the
    // server would refuse anyway costs no chain read.
    if (this.settlement) {
      const verdict = await this.settlement.admit(params.jobId, {
        capability: params.capability,
        callerDid: params.callerDid,
      });
      if (!verdict.ok) return rpcError(id, RpcErrorCode.JobNotFunded, verdict.reason);
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
      const output = deadline === undefined ? await work : await Promise.race([work, deadline]);
      if (this.settlement) {
        // DELIVERED is produced by the chain, not reported to it: the
        // settlement's submit either lands, and the task carries what
        // landed, or throws, and the task fails with the chain's reason.
        const delivery = await this.settlement.deliver(params.jobId, output, { taskId, capability: params.capability });
        this.machine.deliver(taskId, delivery.deliverable, delivery.reference);
      } else {
        this.machine.deliver(taskId, output);
      }
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

  private async status(id: JsonRpcId, params: TaskStatusParams, context: CallContext): Promise<JsonRpcResponse> {
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
    // The job's status is read now and returned, not kept: whether the
    // evaluator has completed or rejected the job is the chain's to say, and
    // a copy of it here would be a second ledger that could disagree.
    const job = this.settlement?.jobStatus ? await this.settlement.jobStatus(task.jobId) : undefined;
    return rpcResult(id, {
      taskId: task.id,
      state: task.state,
      ...(task.deliverable !== undefined ? { deliverable: task.deliverable } : {}),
      ...(task.reason !== undefined ? { reason: task.reason } : {}),
      ...(task.reference !== undefined ? { reference: task.reference } : {}),
      ...(job !== undefined ? { job: { status: job, name: JOB_STATUS_NAMES[job] ?? String(job) } } : {}),
      updatedAt: task.updatedAt,
    });
  }
}
