import type Anthropic from "@anthropic-ai/sdk";
import type { A2AClient, TaskStatusResult, WellKnownCache } from "@squaresdk/a2a";
import type { SquareClient } from "@squaresdk/core";
import { hire, HireRefusedError, lookupAgent, type AgentProfile, type DidResolverLike, type HireResult } from "@squaresdk/mcp";
import { formatUnits } from "viem";
import type { PolicyAllowance } from "./allowance.js";
import type { ToolOutcome } from "./model.js";

export const DELEGATE_TOOL = "delegate";

/** The tool a delegating capability's model is given. The agents it may name are in the description; the allowlist is enforced regardless. */
export function delegateTool(allow: readonly string[]): Anthropic.Tool {
  return {
    name: DELEGATE_TOOL,
    description:
      "Hire another Square agent for a subtask. Escrows USDC from this agent's wallet for the agent's capability, gives it the " +
      "task, and waits for it. Returns the job id, the task's state and, when delivered, the deliverable's on-chain reference " +
      "(and the content when it can be fetched). Only these agents may be hired: " +
      allow.join(", ") +
      ". Each hire is counted against the institution's daily policy allowance and is refused when it would exceed it.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "One of the allowed agents, as listed: its did:aip or https URL." },
        capability: { type: "string", description: "The capability id to hire it for, from its card (for example text.summarize)." },
        input: { type: "string", description: "The subtask, as that capability expects it." },
        budget: { type: "string", description: "USDC to escrow, decimal. Defaults to the capability's price." },
      },
      required: ["agent", "capability", "input"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export interface DelegationDeps {
  /** The hosted agent's wallet: the delegated jobs' client, and the poster whose policy the allowance reads. */
  client: SquareClient;
  a2a: A2AClient;
  resolver: DidResolverLike;
  cards: WellKnownCache;
  allowance: PolicyAllowance;
  allow: readonly string[];
  /** The DID the delegated tasks are created under: the hosted agent's own. */
  callerDid: string;
  taskTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  jobDays?: number | undefined;
  /**
   * The content behind a delivered task's reference, when there is a way to
   * get it: a CID through a gateway, an agent's own channel. A2A carries
   * the reference, not the work (docs/a2a/README.md), so without this the
   * model is told the hash and the transaction and nothing more.
   */
  resolveDeliverable?: ((task: TaskStatusResult, profile: AgentProfile) => Promise<string | undefined>) | undefined;
  /** Told of every job funded, with the capability it bought and its budget: the release duty tracks it from here (square#335). */
  onFunded?: ((jobId: bigint, capability: string, budget: bigint) => void) | undefined;
}

export interface DelegationInput {
  agent: string;
  capability: string;
  input: string;
  budget?: string | undefined;
}

export interface DelegationOutcome extends ToolOutcome {
  /** Present once a job was funded, whatever happened after. */
  result?: HireResult;
}

/**
 * One hire, on the model's behalf, under the institution's allowance.
 *
 * The allowlist is the institution's, not the model's: an agent outside it
 * is refused before a lookup. The allowance is asked before the first
 * transaction and told after the last, so a hire that would put the
 * wallet past the policy's ceiling never funds a job, and every job that
 * is funded is counted until the chain settles it. What comes back is
 * text for the model: the job, the task's state, the reference, and the
 * escrow's fate when the task did not deliver.
 */
export async function delegate(deps: DelegationDeps, input: DelegationInput): Promise<DelegationOutcome> {
  const reference = input.agent.trim();
  if (!allowed(deps.allow, reference)) {
    return { content: `${reference} is not an agent this one may hire; allowed: ${deps.allow.join(", ")}`, isError: true };
  }
  let profile: AgentProfile;
  try {
    profile = await lookupAgent(reference, {
      resolver: deps.resolver,
      cards: deps.cards,
      chainId: deps.client.deployment.chainId,
      usdc: deps.client.deployment.usdc,
    });
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
  if (!allowed(deps.allow, reference) && !allowed(deps.allow, profile.did)) {
    return { content: `${profile.did} is not an agent this one may hire`, isError: true };
  }

  let result: HireResult;
  try {
    result = await hire({
      client: deps.client,
      a2a: deps.a2a,
      profile,
      capability: input.capability,
      input: input.input,
      budget: input.budget,
      jobDays: deps.jobDays,
      callerDid: deps.callerDid,
      taskTimeoutMs: deps.taskTimeoutMs,
      pollIntervalMs: deps.pollIntervalMs,
      admit: (amount) => deps.allowance.admit(amount),
      onFunded: (job) => {
        deps.onFunded?.(job.jobId, input.capability, job.budget);
        return deps.allowance.funded(job);
      },
    });
  } catch (error) {
    if (error instanceof HireRefusedError) {
      const spent = error.stage === "funding" ? " Transactions that landed: " + JSON.stringify(error.transactions) + "." : " Nothing was spent.";
      return { content: `${error.message}.${spent}`, isError: true };
    }
    throw error;
  }

  const who = profile.name ? `${profile.name} (${profile.did})` : profile.did;
  const head = `Delegated to ${who}: job ${result.jobId} funded with ${formatUnits(result.budget, 6)} USDC for ${input.capability}.`;
  switch (result.dispatch) {
    case "delivered": {
      const task = result.task!;
      const lines = [
        head,
        `Task ${result.taskId} DELIVERED; deliverable ${task.deliverable} is the hash the agent's submit put on chain${task.reference ? ` (transaction ${task.reference})` : ""}.`,
        task.job ? `Job status on chain: ${task.job.name}.` : "",
      ];
      const content = await deps.resolveDeliverable?.(task, profile);
      if (content !== undefined) lines.push("", "The agent's deliverable:", content);
      else lines.push("The work itself is not carried over A2A; only its reference is. Report the reference to the client.");
      return { content: lines.filter((l) => l !== "").join("\n"), result };
    }
    case "failed":
      return {
        content: `${head}\nTask ${result.taskId} FAILED: ${result.reason ?? "no reason given"}. The escrow stays on job ${result.jobId} until the evaluator settles it or it expires.`,
        isError: true,
        result,
      };
    case "working":
      return {
        content: `${head}\nTask ${result.taskId} is still running after ${Math.round((deps.taskTimeoutMs ?? 50_000) / 1000)} s; the agent's submit will land later. Report the job id to the client.`,
        result,
      };
    case "undispatched":
      return {
        content:
          `${head}\nThe task could not be handed to the agent: ${result.reason ?? "no answer"}. The escrow stays on job ${result.jobId}; ` +
          "delegate again with the same input to try once more, and the escrow returns to this wallet if the job expires undelivered.",
        isError: true,
        result,
      };
  }
}

/** An entry matches by identity: the same DID, or the same origin for URLs. */
export function allowed(allow: readonly string[], reference: string): boolean {
  const ref = reference.trim();
  return allow.some((entry) => {
    const e = entry.trim();
    if (e === ref) return true;
    if (/^https?:\/\//i.test(e) && /^https?:\/\//i.test(ref)) {
      try {
        return new URL(e).origin === new URL(ref).origin;
      } catch {
        return false;
      }
    }
    return false;
  });
}
