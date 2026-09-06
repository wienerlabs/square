import { TaskState, isTerminalTaskState } from "./states.js";

/**
 * The task lifecycle, as a pure state machine.
 *
 * The predecessor's version wrote to Supabase, kept its records on globalThis,
 * and logged lines like "5 USDC released to Scribe" as a side effect of the
 * provider reporting success. All three are gone. Storage is the caller's
 * problem, and a state machine that narrates payments is a state machine that
 * has an opinion about payments.
 *
 * Transitions:
 *
 *   SUBMITTED ─accept──> WORKING ─deliver──> DELIVERED
 *       │                   └─────fail─────> FAILED
 *       ├────fail─────────────────────────-> FAILED
 *       └────cancel───────────────────────-> CANCELLED
 *
 * Cancelling is only possible before acknowledgement. Once a provider is
 * working, the caller cannot take the task back by saying so — the work may
 * already be done, and the escrow is settled by the evaluator either way.
 */

export interface TaskRecord {
  id: string;
  capability: string;
  input: string;
  callerDid: string;
  /** The ERC-8183 job this task is being performed against. */
  jobId: string;
  state: TaskState;
  /** Set on DELIVERED: a reference to the work, sized for ERC-8183's bytes32. */
  deliverable?: string;
  /** Set on FAILED. */
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export class TaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly attempted: string,
  ) {
    super(`cannot ${attempted} task ${taskId} in state ${from}`);
    this.name = "TaskTransitionError";
  }
}

export type TaskListener = (task: TaskRecord, previous: TaskState) => void;

/**
 * Holds tasks for the lifetime of whoever constructs it.
 *
 * Explicitly not a singleton and explicitly not persistent. A provider process
 * keeps one of these; a caller that needs tasks to survive a restart writes
 * them somewhere itself, from the listener.
 */
export class TaskMachine {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<TaskListener>();

  /** Fires after every accepted transition. Throwing from a listener cannot break a transition. */
  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: TaskRecord, previous: TaskState): void {
    for (const listener of this.listeners) {
      try {
        listener(task, previous);
      } catch {
        /* a subscriber's failure is not the machine's failure */
      }
    }
  }

  private transition(taskId: string, from: readonly TaskState[], to: TaskState, attempted: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskTransitionError(taskId, TaskState.Submitted, `${attempted} (no such task)`);
    if (!from.includes(task.state)) throw new TaskTransitionError(taskId, task.state, attempted);
    const previous = task.state;
    task.state = to;
    task.updatedAt = new Date().toISOString();
    this.emit(task, previous);
    return task;
  }

  create(params: {
    id: string;
    capability: string;
    input: string;
    callerDid: string;
    jobId: string;
  }): TaskRecord {
    if (this.tasks.has(params.id)) {
      throw new TaskTransitionError(params.id, TaskState.Submitted, "create (id already used)");
    }
    const now = new Date().toISOString();
    const task: TaskRecord = { ...params, state: TaskState.Submitted, createdAt: now, updatedAt: now };
    this.tasks.set(task.id, task);
    this.emit(task, TaskState.Submitted);
    return task;
  }

  accept(taskId: string): TaskRecord {
    return this.transition(taskId, [TaskState.Submitted], TaskState.Working, "accept");
  }

  /**
   * The provider claims the work is done.
   *
   * This is the state whose name used to mean "paid". It means the provider is
   * ready to call `submit`, and nothing more: the escrow is untouched, and it
   * stays untouched until the evaluator acts or the challenge window closes.
   */
  deliver(taskId: string, deliverable: string): TaskRecord {
    if (!deliverable) throw new TaskTransitionError(taskId, TaskState.Working, "deliver (empty deliverable)");
    const task = this.transition(taskId, [TaskState.Working], TaskState.Delivered, "deliver");
    task.deliverable = deliverable;
    return task;
  }

  fail(taskId: string, reason: string): TaskRecord {
    const task = this.transition(
      taskId,
      [TaskState.Submitted, TaskState.Working],
      TaskState.Failed,
      "fail",
    );
    task.reason = reason;
    return task;
  }

  cancel(taskId: string): TaskRecord {
    return this.transition(taskId, [TaskState.Submitted], TaskState.Cancelled, "cancel");
  }

  get(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  /**
   * Drop tasks that reached a terminal state before `before`.
   *
   * The predecessor scheduled a setTimeout per task, which keeps a timer alive
   * per task for an hour and never fires if the process restarts. Sweeping is
   * the caller's decision and costs nothing when it is not called.
   */
  sweep(before: Date): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (isTerminalTaskState(task.state) && new Date(task.updatedAt) < before) {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
