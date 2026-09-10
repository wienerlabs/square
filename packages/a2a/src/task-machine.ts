import { TaskState, isDisposableTaskState, isTerminalTaskState } from "./states.js";

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
  /**
   * @param from The state the task was in, or `null` when there was no such
   *   task. A missing task has no state, and reporting one for it would send a
   *   caller looking for a transition rule that was never the problem.
   */
  constructor(
    readonly taskId: string,
    readonly from: TaskState | null,
    readonly attempted: string,
  ) {
    super(
      from === null
        ? `cannot ${attempted}: no such task ${taskId}`
        : `cannot ${attempted} task ${taskId} in state ${from}`,
    );
    this.name = "TaskTransitionError";
  }
}

/**
 * `previous` is `null` when the task was just created. A creation has no
 * state before it, and a listener that persists records needs to tell one
 * from a transition without comparing `previous` to `task.state`.
 */
export type TaskListener = (task: TaskRecord, previous: TaskState | null) => void;

/**
 * Holds tasks for the lifetime of whoever constructs it.
 *
 * Explicitly not a singleton and explicitly not persistent. A provider process
 * keeps one of these; a caller that needs tasks to survive a restart writes
 * them somewhere itself, from the listener. The listener sees the record
 * complete: `deliverable` is set when it hears DELIVERED and `reason` when it
 * hears FAILED, so serialising at that moment loses nothing.
 */
export class TaskMachine {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<TaskListener>();

  /** Fires after every accepted transition. Throwing from a listener cannot break a transition. */
  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: TaskRecord, previous: TaskState | null): void {
    for (const listener of this.listeners) {
      try {
        listener(task, previous);
      } catch {
        /* a subscriber's failure is not the machine's failure */
      }
    }
  }

  /**
   * `apply` writes whatever the new state carries, before listeners hear
   * about it. Writing after `transition` returned would mean the listener
   * sees DELIVERED with no deliverable, which is the field it is there for.
   */
  private transition(
    taskId: string,
    from: readonly TaskState[],
    to: TaskState,
    attempted: string,
    apply?: (task: TaskRecord) => void,
  ): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskTransitionError(taskId, null, attempted);
    if (!from.includes(task.state)) throw new TaskTransitionError(taskId, task.state, attempted);
    const previous = task.state;
    task.state = to;
    task.updatedAt = new Date().toISOString();
    apply?.(task);
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
    const existing = this.tasks.get(params.id);
    if (existing) {
      throw new TaskTransitionError(params.id, existing.state, "create (id already used)");
    }
    const now = new Date().toISOString();
    const task: TaskRecord = { ...params, state: TaskState.Submitted, createdAt: now, updatedAt: now };
    this.tasks.set(task.id, task);
    this.emit(task, null);
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
    return this.transition(taskId, [TaskState.Working], TaskState.Delivered, "deliver", (task) => {
      task.deliverable = deliverable;
    });
  }

  fail(taskId: string, reason: string): TaskRecord {
    return this.transition(
      taskId,
      [TaskState.Submitted, TaskState.Working],
      TaskState.Failed,
      "fail",
      (task) => {
        task.reason = reason;
      },
    );
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
   * Drop the record of a task the host is finished with.
   *
   * The only way a DELIVERED task leaves the machine. `sweep` will not take
   * it, because the provider still owes the chain a `submit` for it and the
   * deliverable lives nowhere else; the host, which made that call, is the
   * one party that knows when the record has served its purpose. A task that
   * is still live is refused: a handler that is running would then deliver
   * into nothing.
   */
  forget(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskTransitionError(taskId, null, "forget");
    if (!isTerminalTaskState(task.state)) throw new TaskTransitionError(taskId, task.state, "forget");
    this.tasks.delete(taskId);
    return task;
  }

  /**
   * Drop tasks with nothing left to do that went quiet before `before`:
   * FAILED and CANCELLED. Not DELIVERED, which is terminal in the sense that
   * it will not change again and not in the sense that the work is over; see
   * `isDisposableTaskState`. A host drops a DELIVERED task with `forget`,
   * once it has submitted.
   *
   * The predecessor scheduled a setTimeout per task, which keeps a timer alive
   * per task for an hour and never fires if the process restarts. Sweeping is
   * the caller's decision and costs nothing when it is not called.
   */
  sweep(before: Date): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (isDisposableTaskState(task.state) && new Date(task.updatedAt) < before) {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
