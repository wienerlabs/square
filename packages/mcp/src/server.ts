import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { A2AClient, A2AError, JOB_STATUS_NAMES, TaskState, WellKnownCache, type TaskStatusResult } from "@squaresdk/a2a";
import { JobStatus, type JobStatusValue, type SquareClient } from "@squaresdk/core";
import { createPayingFetch, decodePaymentResponseHeader, networkOf, PAYMENT_RESPONSE_HEADER } from "@squaresdk/x402";
import { formatUnits, parseUnits, type Hex, type LocalAccount } from "viem";
import { z } from "zod";
import { AgentLookupError, lookupAgent, type AgentProfile, type DidResolverLike } from "./agents.js";

export interface SquareMcpServerOptions {
  /**
   * The chain, and the wallet that pays. With a wallet the server hires;
   * without one it only reads, and the tools that would spend are not
   * offered at all, so a model never sees a tool it cannot use.
   */
  client: SquareClient;
  resolver: DidResolverLike;
  a2a?: A2AClient | undefined;
  cards?: WellKnownCache | undefined;
  /**
   * The DID a task is created under. Nothing on the A2A wire checks it
   * (see packages/a2a/README.md), so it is a name the caller answers to: a
   * did:aip when the wallet owns an agent, and otherwise the wallet's
   * `did:pkh`, which is the default, and which is also the job's client on
   * chain.
   */
  callerDid?: string | undefined;
  /** With it, `square_call` pays a priced capability per call over x402 instead of escrowing a job. */
  x402?: { account: LocalAccount; maxAmountPerPayment: string; fetch?: typeof globalThis.fetch | undefined } | undefined;
  /** How long a job stays open for the agent, when the call does not say. Default seven days, or a day past the settlement horizon if that is longer. */
  jobDays?: number | undefined;
  /** How long `square_hire` waits for the task before handing back the ids to poll with. Default 50 s: under a client's usual 60 s tool timeout. */
  taskTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  serverInfo?: { name: string; version: string } | undefined;
  now?: (() => number) | undefined;
}

const USDC = /^\d+(\.\d{1,6})?$/;
const AGENT = z.string().min(1).describe("The agent's did:aip (did:aip:eip155:<chain>:<registry>:<id>) or its https URL.");

type Structured = Record<string, unknown>;

/**
 * Square as an MCP server, for a client such as Claude Desktop or Cursor.
 *
 * Five tools. `square_agent` looks an agent up by DID or URL and says what
 * it offers and for how much; `square_hire` escrows a job for it on
 * SquareJob and gives it the task over A2A; `square_task` and `square_job`
 * read where the task and the job stand afterwards; `square_call` pays a
 * capability per call through x402, for an agent that serves it that way.
 *
 * The money moves the way it does everywhere else in this repository:
 * `square_hire` creates, budgets and funds the job from the wallet, the
 * agent's `submit` puts the deliverable's hash on chain, and the evaluator
 * settles. What comes back from a hire is that hash and the transaction
 * that carried it, never the work itself; A2A carries a reference to the
 * deliverable, not the deliverable (docs/a2a/README.md). `square_call` is
 * the one that answers with the output, because x402 is a payment for a
 * response.
 */
export function createSquareMcpServer(options: SquareMcpServerOptions): McpServer {
  const { client, resolver } = options;
  const a2a = options.a2a ?? new A2AClient();
  const cards = options.cards ?? new WellKnownCache();
  const now = options.now ?? Date.now;
  const chainId = client.deployment.chainId;
  const usdc = client.deployment.usdc;
  const canSpend = client.walletClient !== undefined;
  const taskTimeoutMs = options.taskTimeoutMs ?? 50_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const server = new McpServer(options.serverInfo ?? { name: "square", version: "0.1.0" }, {
    instructions:
      `Square is escrowed work for autonomous agents on chain ${chainId}. ` +
      "Look an agent up with square_agent before hiring it; square_hire escrows USDC from this wallet and returns " +
      "the deliverable's on-chain reference, not the work itself. " +
      (canSpend ? `Paying wallet: ${client.account}.` : "No wallet is configured: this server reads and does not hire."),
  });

  const lookup = (reference: string): Promise<AgentProfile> => lookupAgent(reference, { resolver, cards, chainId, usdc });

  // One hire at a time. A model may call tools concurrently, and two
  // transactions signed from one wallet in the same instant can take the
  // same nonce; a queue costs a hire nothing it would not have spent waiting
  // for its own receipts.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  server.registerTool(
    "square_agent",
    {
      title: "Look up a Square agent",
      description:
        "Resolve an agent by its did:aip or https URL: who owns it on ERC-8004, whether it is active, its A2A endpoint, " +
        "and the capabilities its agent card offers with their prices in USDC. Read-only; call it before square_hire.",
      inputSchema: { agent: AGENT },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agent }) => {
      try {
        const profile = await lookup(agent);
        return ok(describeProfile(profile), profileContent(profile));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "square_job",
    {
      title: "Read a Square job",
      description: "The job record on SquareJob: status, client, provider, budget, expiry, deliverable, and the ERC-8004 agent bound to it.",
      inputSchema: { jobId: z.string().regex(/^\d+$/).describe("Decimal job id, as square_hire returned it.") },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      try {
        const id = BigInt(jobId);
        const record = await client.getJobRecord(id);
        const agentId = await client.agentOf(id);
        const status = record.status as JobStatusValue;
        const content: Structured = {
          jobId,
          status: JOB_STATUS_NAMES[status] ?? String(status),
          client: record.client,
          provider: record.provider,
          evaluator: record.evaluator,
          budget: formatUnits(record.budget, 6),
          createdAt: iso(record.createdAt),
          expiredAt: iso(record.expiredAt),
          ...(record.fundedAt ? { fundedAt: iso(record.fundedAt) } : {}),
          ...(record.submittedAt ? { submittedAt: iso(record.submittedAt) } : {}),
          deliverable: record.deliverable,
          agentId: agentId === null ? null : agentId.toString(),
        };
        return ok(
          [
            `Job ${jobId}: ${content.status as string}.`,
            `client ${record.client}, provider ${record.provider}, evaluator ${record.evaluator}`,
            `budget ${content.budget as string} USDC, expires ${content.expiredAt as string}`,
            `deliverable ${record.deliverable}${agentId === null ? ", no agent bound" : `, bound to agent ${agentId}`}`,
          ].join("\n"),
          content,
        );
      } catch (error) {
        return failed(error, `job ${jobId} could not be read`);
      }
    },
  );

  server.registerTool(
    "square_task",
    {
      title: "Poll a task at an agent",
      description:
        "Where a task stands at the agent that runs it: WORKING, DELIVERED with the deliverable's hash and the submit transaction, " +
        "or FAILED with the reason. Use it when square_hire returned before the task finished.",
      inputSchema: { agent: AGENT, taskId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agent, taskId }) => {
      try {
        const profile = await lookup(agent);
        if (profile.a2aEndpoint === undefined) return failed(`${profile.did} advertises no A2A endpoint`);
        const status = await a2a.taskStatus(profile.a2aEndpoint, taskId);
        return ok(describeTask(status), taskContent(status));
      } catch (error) {
        return failed(error);
      }
    },
  );

  if (!canSpend) return server;
  const callerDid = options.callerDid ?? `did:pkh:eip155:${chainId}:${client.account}`;

  server.registerTool(
    "square_hire",
    {
      title: "Hire a Square agent",
      description:
        "Escrow a job on SquareJob for the agent and give it the task over A2A. Spends USDC from this wallet: the job is created for " +
        "the agent's wallet, budgeted with the capability's price (or `budget`), funded, and the task is dispatched against it. " +
        "Returns the job id, the task's state, and on DELIVERED the deliverable's hash and the submit transaction; " +
        "the evaluator settles the escrow afterwards. The output itself is not on the wire; square_call is, for agents that serve x402.",
      inputSchema: {
        agent: AGENT,
        capability: z.string().min(1).describe("A capability id from square_agent, such as text.summarize."),
        input: z.string().describe("The work, as the capability expects it."),
        budget: z.string().regex(USDC).optional().describe("USDC to escrow. Defaults to the capability's price; required when it has none."),
        expiresInDays: z.number().int().min(1).max(365).optional().describe("How long the agent has. Default seven days."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ agent, capability, input, budget, expiresInDays }) =>
      serially(async () => {
        let profile: AgentProfile;
        try {
          profile = await lookup(agent);
        } catch (error) {
          return failed(error);
        }
        if (profile.deactivated) return failed(`${profile.did} is deactivated`);
        if (profile.a2aEndpoint === undefined) return failed(`${profile.did} advertises no A2A endpoint`);
        const offered = profile.capabilities.find((c) => c.id === capability);
        if (!offered) {
          const ids = profile.capabilities.map((c) => c.id);
          return failed(`${profile.name || profile.did} does not offer ${capability}; it offers ${ids.length ? ids.join(", ") : "nothing"}`);
        }
        const price = budget ?? offered.price;
        if (price === undefined) return failed(`${capability} has no price on the card; pass budget`);
        const amount = parseUnits(price, 6);
        if (amount <= 0n) return failed("budget must be above zero");
        if (offered.price !== undefined && amount < parseUnits(offered.price, 6)) {
          return failed(`budget ${price} is below the price of ${capability}, ${offered.price} USDC; the agent would refuse the task`);
        }

        let transactions: Structured = {};
        let jobId: bigint;
        try {
          const balance = await client.usdcBalance(client.account);
          if (balance < amount) return failed(`the wallet holds ${formatUnits(balance, 6)} USDC; the job needs ${price}`);
          const horizon = await client.settlementHorizon();
          const days = expiresInDays ?? Math.max(options.jobDays ?? 7, Math.ceil((horizon + 86_400) / 86_400));
          const seconds = days * 86_400;
          if (seconds < horizon + 3_600) {
            return failed(
              `expiresInDays must be at least ${Math.ceil((horizon + 3_600) / 86_400)}: the agent's submit needs the settlement horizon ` +
                `(${Math.round(horizon / 3_600)} h) ahead of the job's expiry`,
            );
          }
          const expiredAt = BigInt(Math.floor(now() / 1000) + seconds);
          const created = await client.createJob({
            provider: profile.provider,
            expiredAt,
            spec: { agent: profile.did, capability, input },
          });
          jobId = created.jobId;
          transactions = { createJob: created.hash };
          transactions.setBudget = (await client.setBudget(jobId, amount)).hash;
          transactions.fund = (await client.fund(jobId, amount)).hash;
        } catch (error) {
          return failed(error, "the job could not be funded", transactions);
        }

        const taskId = `square-job-${jobId}`;
        const base: Structured = {
          jobId: jobId.toString(),
          taskId,
          agent: profile.did,
          provider: profile.provider,
          capability,
          budget: price,
          transactions,
        };
        const head = `Job ${jobId} funded with ${price} USDC for ${profile.name || profile.did}, capability ${capability}.`;
        let status: TaskStatusResult;
        try {
          status = await a2a.runTask(
            profile.a2aEndpoint,
            { taskId, capability, input, callerDid, jobId: jobId.toString() },
            { pollIntervalMs, maxPolls: Math.max(1, Math.floor(taskTimeoutMs / pollIntervalMs)) },
          );
        } catch (error) {
          if (error instanceof A2AError && error.kind === "timeout") {
            return ok(
              `${head}\nTask ${taskId} is still running after ${Math.round(taskTimeoutMs / 1000)} s. Poll it with square_task; ` +
                `the escrow waits for the agent's submit, and returns to this wallet through claimRefund if the job expires undelivered.`,
              { ...base, task: { state: TaskState.Working } },
            );
          }
          return failed(
            error,
            `${head}\nThe task could not be dispatched. The escrow stays on job ${jobId} until the evaluator settles it or it expires, ` +
              "when claimRefund returns it to this wallet",
            base,
          );
        }
        const content = { ...base, ...taskContent(status) };
        if (status.state === TaskState.Failed) {
          return failed(
            `${head}\n${describeTask(status)}\nThe escrow stays on job ${jobId}; claimRefund returns it to this wallet once the job expires.`,
            undefined,
            content,
          );
        }
        return ok(`${head}\n${describeTask(status)}`, content);
      }),
  );

  const x402 = options.x402;
  if (x402 === undefined) return server;
  const cap = parseUnits(x402.maxAmountPerPayment, 6);
  const payingFetch = createPayingFetch({
    account: x402.account,
    maxAmountPerPayment: x402.maxAmountPerPayment,
    network: networkOf(chainId),
    asset: usdc,
    ...(x402.fetch ? { fetch: x402.fetch } : {}),
  });

  server.registerTool(
    "square_call",
    {
      title: "Pay an agent per call",
      description:
        "Call a priced capability and pay for the one response over x402, with no job and no escrow. Only for agents whose card says " +
        `x402Support; spends at most ${x402.maxAmountPerPayment} USDC per call from this wallet. Returns the agent's output.`,
      inputSchema: {
        agent: AGENT,
        capability: z.string().min(1).describe("A priced capability id from square_agent."),
        input: z.string().describe("The work, as the capability expects it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ agent, capability, input }) => {
      let profile: AgentProfile;
      try {
        profile = await lookup(agent);
      } catch (error) {
        return failed(error);
      }
      if (!profile.x402Support) return failed(`${profile.name || profile.did} does not serve x402; hire it with square_hire instead`);
      if (profile.a2aEndpoint === undefined) return failed(`${profile.did} advertises no endpoint`);
      const offered = profile.capabilities.find((c) => c.id === capability);
      if (!offered) return failed(`${profile.name || profile.did} does not offer ${capability}`);
      if (offered.price === undefined) return failed(`${capability} is not priced per call`);
      if (parseUnits(offered.price, 6) > cap) {
        return failed(`${capability} costs ${offered.price} USDC per call, above this server's cap of ${x402.maxAmountPerPayment}`);
      }
      const url = `${new URL(profile.a2aEndpoint).origin}/pay/${capability}`;
      let response: Response;
      try {
        response = await payingFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input }),
        });
      } catch (error) {
        return failed(error, `${url} could not be paid`);
      }
      const body = await response.text();
      if (response.status === 402) return failed(`${url} did not accept the payment: ${body.slice(0, 300)}`);
      if (!response.ok) return failed(`${url} answered ${response.status}: ${body.slice(0, 300)}`);
      let parsed: { output?: unknown };
      try {
        parsed = JSON.parse(body) as { output?: unknown };
      } catch {
        return failed(`${url} answered with a body that is not JSON`);
      }
      const output = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
      const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
      let settlement: { transaction: string; network: string } | undefined;
      if (header) {
        try {
          const decoded = decodePaymentResponseHeader(header);
          settlement = { transaction: decoded.transaction, network: decoded.network };
        } catch {
          /* the header is the gateway's; an unreadable one is reported as absent */
        }
      }
      return ok(`${output}\n\nPaid ${offered.price} USDC to ${profile.name || profile.did}${settlement ? ` (settlement ${settlement.transaction})` : ""}.`, {
        agent: profile.did,
        capability,
        price: offered.price,
        output,
        ...(settlement ? { settlement } : {}),
      });
    },
  );

  return server;
}

function ok(text: string, structuredContent: Structured): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failed(error: unknown, context?: string, structuredContent?: Structured): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const text = context ? `${context}: ${message}` : message;
  return { content: [{ type: "text", text }], isError: true, ...(structuredContent ? { structuredContent } : {}) };
}

function iso(seconds: number | bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function describeProfile(p: AgentProfile): string {
  const lines = [
    `${p.name || "(unnamed)"}: ${p.did}`,
    p.description,
    `owner ${p.owner}; jobs are created for ${p.provider}${p.deactivated ? "; DEACTIVATED" : ""}`,
    p.a2aEndpoint ? `A2A endpoint ${p.a2aEndpoint}${p.x402Support ? ", serves x402 per call" : ""}` : "no A2A endpoint",
    p.capabilities.length
      ? `capabilities:\n${p.capabilities.map((c) => `  ${c.id}${c.price ? ` (${c.price} USDC)` : " (unpriced)"}: ${c.description}`).join("\n")}`
      : "no capabilities",
  ];
  if (p.warnings.length) lines.push(`warnings:\n${p.warnings.map((w) => `  ${w}`).join("\n")}`);
  return lines.filter((line) => line !== "").join("\n");
}

function profileContent(p: AgentProfile): Structured {
  return {
    did: p.did,
    agentId: p.agentId,
    chainId: p.chainId,
    registry: p.registry,
    owner: p.owner,
    provider: p.provider,
    deactivated: p.deactivated,
    name: p.name,
    description: p.description,
    a2aEndpoint: p.a2aEndpoint ?? null,
    x402Support: p.x402Support,
    capabilities: p.capabilities,
    warnings: p.warnings,
  };
}

function describeTask(s: TaskStatusResult): string {
  const lines = [`Task ${s.taskId}: ${s.state}${s.job ? `; job ${s.job.name} on chain` : ""}`];
  if (s.state === TaskState.Delivered) {
    lines.push(`deliverable ${s.deliverable ?? "(none)"} (the hash the agent's submit put on chain${s.reference ? `, in ${s.reference}` : ""})`);
    if (s.job?.status === JobStatus.Submitted) lines.push("The evaluator settles the escrow next; read the job later with square_job.");
  }
  if (s.state === TaskState.Failed) lines.push(`reason: ${s.reason ?? "(none given)"}`);
  return lines.join("\n");
}

function taskContent(s: TaskStatusResult): Structured {
  return {
    task: {
      taskId: s.taskId,
      state: s.state,
      ...(s.deliverable !== undefined ? { deliverable: s.deliverable as Hex } : {}),
      ...(s.reference !== undefined ? { reference: s.reference } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      updatedAt: s.updatedAt,
    },
    ...(s.job ? { job: { status: s.job.name } } : {}),
  };
}
