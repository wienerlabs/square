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
  /**
   * Unix seconds the job's window is measured against. The default is the
   * chain's own clock, the latest block's timestamp, because that is what
   * `submit` will be measured against (square#334); a wall clock is for tests.
   */
  now?: (() => bigint | Promise<bigint>) | undefined;
}

/**
 * The least `SquareJob.submit` leaves between the block it lands in and the
 * job's `expiredAt`: `_settlementWindow` takes the job's settlement horizon
 * and never less than this. A Solidity `constant`, so mirrored rather than
 * read; test/anvil.test.ts holds the mirror to the deployed kernel.
 */
export const MIN_SETTLEMENT_WINDOW = 15n * 60n;
const ZERO32 = `0x${"0".repeat(64)}`;

/** `_settlementWindow(horizon)` of SquareJob: the horizon, floored. */
export function settlementWindowOf(settlementHorizon: bigint): bigint {
  return settlementHorizon < MIN_SETTLEMENT_WINDOW ? MIN_SETTLEMENT_WINDOW : settlementHorizon;
}

/**
 * `@squaresdk/a2a`'s settlement seam, over `@squaresdk/core` (square#79).
 *
 * The three answers are the chain's. Admission reads the job record and
 * requires it Funded, for this wallet, above the capability's price,
 * still submittable: `submit` refuses a job with less than its settlement
 * window left before `expiredAt` (`ExpiryTooShort`), so a job the agent could
 * take but never deliver is refused before any work is done (square#334); and
 * payable: on a hook with a compliance module, a client with no policy on the
 * registry cannot be released to (square#350). The
 * deliverable is `hashDeliverable` of the handler's output,
 * put on chain with `submit` and bound to `agentId`, and DELIVERED carries
 * the hash that the `JobSubmitted` event confirms; the job's status is read
 * from the record each time it is asked for, never kept.
 */
export function squareSettlement(options: SquareSettlementOptions): TaskSettlement {
  const { client, agentId } = options;
  const now = options.now ?? (async () => (await client.publicClient.getBlock({ blockTag: "latest" })).timestamp);

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
      let at: bigint;
      try {
        at = await now();
      } catch (error) {
        return { ok: false, reason: `the chain's clock could not be read for job ${jobId}: ${error instanceof Error ? error.message : String(error)}` };
      }
      const expiredAt = BigInt(record.expiredAt);
      if (expiredAt <= at) {
        return { ok: false, reason: `job ${jobId} expired at ${record.expiredAt}` };
      }
      // submit's own rule: expiredAt >= block.timestamp + _settlementWindow(horizon).
      // Measured now rather than after the work, so this is the floor of what
      // the handler's run has to fit into, not a promise that it will.
      const window = settlementWindowOf(BigInt(record.settlementHorizon));
      if (expiredAt < at + window) {
        return {
          ok: false,
          reason:
            `job ${jobId} cannot be submitted: it expires at ${record.expiredAt}, ${expiredAt - at}s from now, ` +
            `and submit needs ${window}s before expiry (settlement horizon ${record.settlementHorizon}s, floor ${MIN_SETTLEMENT_WINDOW}s)`,
        };
      }
      const minimum = options.minimumBudgetFor?.(task.capability);
      if (minimum !== undefined && record.budget < minimum) {
        return { ok: false, reason: `job ${jobId} is funded with ${record.budget} but ${task.capability} costs ${minimum}` };
      }
      // On a stack whose hook holds a compliance module, a release to a
      // client with no policy on the registry is refused for certain (the
      // module's `policy commitment` binding), and the whole net goes back to
      // the client: the work would be done for nothing (square#350). Read at
      // admission, before the handler runs. A client may commit later, so the
      // refusal says what would make the job payable.
      try {
        if ((await client.complianceModule()) !== null && (await client.policyOf(record.client)).commitment === ZERO32) {
          return {
            ok: false,
            reason: `job ${jobId} cannot pay: the hook holds a compliance module and its client ${record.client} has no policy on the registry, so the release would be refused; the client has to commit a policy first`,
          };
        }
      } catch (error) {
        return { ok: false, reason: `the compliance gate could not be read for job ${jobId}: ${error instanceof Error ? error.message : String(error)}` };
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
