import type { JobStatus } from "./states.js";

/**
 * How a task reaches the chain, from the server's point of view.
 *
 * This package holds no wallet, no client and no chain library, and the guard
 * in test/no-self-settlement.test.ts keeps it that way. What it does hold is
 * the two moments at which the chain has a say in a task: before the work is
 * accepted, and when the work is done. Both are handed to whoever composes
 * the server, as three functions that take and return strings:
 *
 *   admit    — is `jobId` funded, for this provider, for this capability?
 *              The answer is the chain's, read from the job record. A task
 *              against a job that is not Funded, or funded for somebody
 *              else, is refused before a handler ever runs (square#79).
 *   deliver  — the handler's output becomes the on-chain `submit`. The
 *              deliverable that DELIVERED carries is what went on chain, and
 *              the reference is the transaction that carried it, so the
 *              state is produced by the chain call rather than reported
 *              alongside it.
 *   jobStatus — what the chain says about the job now, for `task/status`.
 *              The task machine keeps no ledger of outcomes: Completed and
 *              Rejected are the evaluator's, and are read, not recorded.
 *
 * `@squaresdk/agent` implements this over `@squaresdk/core`. A server
 * without a settlement behaves as before: the handler's return value is the
 * deliverable, and nothing is read from or written to a chain.
 */
export interface TaskSettlement {
  admit(jobId: string, task: { capability: string; callerDid: string }): Promise<AdmitVerdict>;
  deliver(jobId: string, content: string, task: { taskId: string; capability: string }): Promise<Delivery>;
  jobStatus?(jobId: string): Promise<JobStatus>;
}

export type AdmitVerdict = { ok: true } | { ok: false; reason: string };

export interface Delivery {
  /** What went on chain: the bytes32 the deliverable is referenced by. */
  deliverable: string;
  /** The transaction that carried it. */
  reference?: string | undefined;
}
