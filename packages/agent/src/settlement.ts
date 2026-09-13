import type { AdmitVerdict, Delivery, TaskSettlement } from "@squaresdk/a2a";
import type { JobStatus as A2AJobStatus } from "@squaresdk/a2a";
import { eventsNamed, hashDeliverable, JobStatus, type SquareClient } from "@squaresdk/core";
import { isAddressEqual } from "viem";

export interface SquareSettlementOptions {
  /** A client whose wallet is the provider: `submit` is signed by it. */
  client: SquareClient;
  /** The ERC-8004 agent the submit binds the job to; the hook checks the wallet owns it. */
  agentId: bigint;
  /**
   * The least a job may be funded with for a capability, in USDC atomic units,
   * or undefined when any funded amount will do. Read at admission, so a job
   * funded below the capability's price is refused before the work is done.
   */
  minimumBudgetFor?: ((capability: string) => bigint | undefined) | undefined;
  /** Unix seconds, for tests. */
  now?: (() => bigint) | undefined;
}

/**
 * `@squaresdk/a2a`'s settlement seam, over `@squaresdk/core` (square#79).
 *
 * The three answers are the chain's. Admission reads the job record and
 * requires it Funded, for this wallet, above the capability's price and not
 * past expiry; the deliverable is `hashDeliverable` of the handler's output,
 * put on chain with `submit` and bound to `agentId`, and DELIVERED carries
 * the hash that the `JobSubmitted` event confirms; the job's status is read
 * from the record each time it is asked for, never kept.
 */
export function squareSettlement(options: SquareSettlementOptions): TaskSettlement {
  const { client, agentId } = options;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  function jobIdOf(jobId: string): bigint | undefined {
    return /^[0-9]+$/.test(jobId) ? BigInt(jobId) : undefined;
  }

  return {
    async admit(jobId, task): Promise<AdmitVerdict> {
      const id = jobIdOf(jobId);
      if (id === undefined) return { ok: false, reason: `jobId ${JSON.stringify(jobId)} is not a job id` };
      let record;
      try {
        record = await client.getJobRecord(id);
      } catch (error) {
        return { ok: false, reason: `job ${jobId} could not be read: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (record.status !== JobStatus.Funded) {
        return { ok: false, reason: `job ${jobId} is ${statusName(record.status)}, not Funded` };
      }
      if (!isAddressEqual(record.provider, client.account)) {
        return { ok: false, reason: `job ${jobId} is funded for provider ${record.provider}, not this agent` };
      }
      if (BigInt(record.expiredAt) <= now()) {
        return { ok: false, reason: `job ${jobId} expired at ${record.expiredAt}` };
      }
      const minimum = options.minimumBudgetFor?.(task.capability);
      if (minimum !== undefined && record.budget < minimum) {
        return { ok: false, reason: `job ${jobId} is funded with ${record.budget} but ${task.capability} costs ${minimum}` };
      }
      return { ok: true };
    },

    async deliver(jobId, content): Promise<Delivery> {
      const id = jobIdOf(jobId);
      if (id === undefined) throw new Error(`jobId ${JSON.stringify(jobId)} is not a job id`);
      const deliverable = hashDeliverable(content);
      const result = await client.submit({ jobId: id, deliverable, agentId });
      const submitted = eventsNamed(result.events, "JobSubmitted").find(
        (event) => event.args.jobId === id && event.args.deliverable === deliverable,
      );
      if (!submitted) throw new Error(`submit for job ${jobId} mined in ${result.hash} without a JobSubmitted event for it`);
      return { deliverable, reference: result.hash };
    },

    async jobStatus(jobId) {
      const id = jobIdOf(jobId);
      if (id === undefined) throw new Error(`jobId ${JSON.stringify(jobId)} is not a job id`);
      // The contract's enum and a2a's JobStatus are the same six values in the
      // same order (a2a/states.ts verified this against the deployed kernel).
      return (await client.getJobRecord(id)).status as A2AJobStatus;
    },
  };
}

const NAMES: Record<number, string> = {
  [JobStatus.Open]: "Open",
  [JobStatus.Funded]: "Funded",
  [JobStatus.Submitted]: "Submitted",
  [JobStatus.Completed]: "Completed",
  [JobStatus.Rejected]: "Rejected",
  [JobStatus.Expired]: "Expired",
};

function statusName(status: number): string {
  return NAMES[status] ?? String(status);
}
