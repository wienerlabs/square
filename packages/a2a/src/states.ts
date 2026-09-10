/**
 * Task state, job state, and the mapping between them.
 *
 * These are two different state machines owned by two different parties, and
 * the whole point of this module is that they are not the same machine.
 *
 * A2A task state is what the provider says about its own work. It is a claim,
 * carried over HTTP, and the provider is the only author of it.
 *
 * ERC-8183 job state is what the chain says about the money. The provider can
 * move it exactly one step — `submit`, from Funded to Submitted — and cannot
 * move it any further. Only the evaluator may call `complete` or `reject`.
 *
 * The names collide in the worst possible place: A2A's COMPLETED means "I have
 * delivered", and ERC-8183's Completed means "the escrow has been paid out".
 * Treating them as the same value is how a provider ends up paying itself.
 */

/** What the provider says about the work. Its authority stops at the HTTP response. */
export const TaskState = {
  /** Dispatched to the provider; not yet acknowledged. */
  Submitted: "SUBMITTED",
  /** Acknowledged and in progress. */
  Working: "WORKING",
  /** The provider claims it has delivered. This is a claim, not a settlement. */
  Delivered: "DELIVERED",
  /** The provider claims it cannot deliver. */
  Failed: "FAILED",
  /** Withdrawn by the caller before the provider acknowledged it. */
  Cancelled: "CANCELLED",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

/**
 * ERC-8183 job status, in the enum order the contract uses.
 *
 * Verified against the deployed registry on Arc Testnet
 * (0x0747EEf0706327138c69792bF28Cd525089e4583) rather than read off the ERC:
 * sampling the first forty jobs returns statuses 0, 1 and 3, which are Open,
 * Funded and Completed under this ordering and nothing else.
 */
export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JOB_STATUS_NAMES: Readonly<Record<JobStatus, string>> = {
  [JobStatus.Open]: "Open",
  [JobStatus.Funded]: "Funded",
  [JobStatus.Submitted]: "Submitted",
  [JobStatus.Completed]: "Completed",
  [JobStatus.Rejected]: "Rejected",
  [JobStatus.Expired]: "Expired",
};

/** The ERC-8183 call a role is permitted to make. */
export type JobAction = "setBudget" | "fund" | "submit" | "complete" | "reject" | "claimRefund";

/**
 * The only job action a provider may take, ever.
 *
 * ERC-8183 gives the provider `setBudget` and `submit` and nothing else;
 * `complete` and `reject` revert for any caller that is not the job's
 * evaluator. `setBudget` is price negotiation and happens before a task is
 * dispatched, so from inside a running task the provider's entire on-chain
 * vocabulary is this one word.
 */
export const PROVIDER_JOB_ACTIONS: readonly JobAction[] = ["submit"];

/** Actions reserved to the evaluator. A provider reaching for one is a bug, not a policy question. */
export const EVALUATOR_ONLY_JOB_ACTIONS: readonly JobAction[] = ["complete", "reject"];

export interface StateMapping {
  task: TaskState;
  /** The job status this task state expects to be in. */
  expects: JobStatus;
  /** What, if anything, the provider is entitled to do on chain at this point. */
  providerAction: JobAction | null;
  /** Where the job goes next, and who takes it there. */
  note: string;
}

/**
 * What each task state means for the job.
 *
 * Read the `providerAction` column downwards: it is `submit` exactly once and
 * `null` everywhere else. Nothing a provider can say over A2A moves a job into
 * a terminal state.
 */
export const STATE_MAPPING: readonly StateMapping[] = [
  {
    task: TaskState.Submitted,
    expects: JobStatus.Funded,
    providerAction: null,
    note: "The escrow is funded and the work has been dispatched. The provider has done nothing on chain yet.",
  },
  {
    task: TaskState.Working,
    expects: JobStatus.Funded,
    providerAction: null,
    note: "Acknowledgement is an HTTP fact. It has no on-chain counterpart, and the job has not moved.",
  },
  {
    task: TaskState.Delivered,
    expects: JobStatus.Funded,
    providerAction: "submit",
    note: "The provider calls submit(jobId, deliverable), taking the job Funded -> Submitted. The escrow does not move. Payment waits for the evaluator, or for the challenge window to close.",
  },
  {
    task: TaskState.Failed,
    expects: JobStatus.Funded,
    providerAction: null,
    note: "There is no on-chain call for giving up. The job stays Funded until the evaluator rejects it or expiredAt passes and anyone calls claimRefund.",
  },
  {
    task: TaskState.Cancelled,
    expects: JobStatus.Funded,
    providerAction: null,
    note: "The caller withdrew before acknowledgement. Unwinding the escrow is the client's and the evaluator's business, not the provider's.",
  },
];

/**
 * Does this task state authorise a provider to make this job call?
 *
 * The answer is yes in exactly one combination. Everything else is false, and
 * a caller that finds itself asking about `complete` has already gone wrong.
 */
export function providerMayCall(task: TaskState, action: JobAction): boolean {
  if (!PROVIDER_JOB_ACTIONS.includes(action)) return false;
  const row = STATE_MAPPING.find((m) => m.task === task);
  return row?.providerAction === action;
}

/**
 * The job status a task state expects to see on chain.
 *
 * Used to catch disagreement between the two machines: a task reporting
 * DELIVERED against a job that is already Completed means somebody settled
 * without waiting, and the caller should stop rather than carry on.
 */
export function expectedJobStatus(task: TaskState): JobStatus {
  const row = STATE_MAPPING.find((m) => m.task === task);
  if (!row) throw new Error(`unknown task state: ${String(task)}`);
  return row.expects;
}

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  TaskState.Delivered,
  TaskState.Failed,
  TaskState.Cancelled,
];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/**
 * Terminal, and with nothing left for the provider to do.
 *
 * `isTerminalTaskState` answers "will this state change again". This answers
 * "can the record be thrown away", and the two differ in exactly one state.
 * DELIVERED is terminal, and it is also the only row of STATE_MAPPING with a
 * `providerAction`: the provider still owes the chain a `submit`, carrying a
 * deliverable that exists nowhere else. A machine that drops the record there
 * drops the one value the provider needed in order to be paid.
 */
export function isDisposableTaskState(state: TaskState): boolean {
  if (!isTerminalTaskState(state)) return false;
  return STATE_MAPPING.find((m) => m.task === state)?.providerAction === null;
}

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.Completed,
  JobStatus.Rejected,
  JobStatus.Expired,
];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}
