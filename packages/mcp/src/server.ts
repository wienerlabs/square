import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { A2AClient, JOB_STATUS_NAMES, TaskState, WellKnownCache, type TaskStatusResult } from "@squaresdk/a2a";
import { JobStatus, type JobStatusValue, type SquareClient } from "@squaresdk/core";
import { ComplianceDuty, proofState, releaseFacts, type DutyEvent, type DutyState, type Policy, type Prover } from "@squaresdk/policy";
import { createPayingFetch, decodePaymentResponseHeader, networkOf, PAYMENT_RESPONSE_HEADER } from "@squaresdk/x402";
import { formatUnits, parseUnits, type Hex, type LocalAccount } from "viem";
import { z } from "zod";
import { lookupAgent, type AgentProfile, type DidResolverLike } from "./agents.js";
import { dispatch, hire, HireRefusedError, type DispatchOutcome, type HireResult } from "./hire.js";

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
  /**
   * The institution's side of the compliance gate (square#335). With it,
   * every job `square_hire` funds is tracked by a `ComplianceDuty`: a proof
   * that the release fits `policy` is built at the prover and bound to the
   * job, kept current as the payee, the net and the day's counter move, and
   * the job is cranked once its window closes. Without it, on a stack whose
   * hook holds a module, every hire's release would pay the client back.
   */
  compliance?: ComplianceOptions | undefined;
}

export interface ComplianceOptions {
  policy: Policy;
  prover: Prover;
  /** How often the duty looks at its jobs; well inside the module's tolerance. Default 15 s. */
  intervalMs?: number | undefined;
  onEvent?: ((event: DutyEvent) => void) | undefined;
  /**
   * Where the duty keeps its jobs across restarts (square#348): a hire's
   * window outlives the process that funded it. `fileDutyState` from
   * `@squaresdk/policy/node` is one; without it the duty still finds this
   * wallet's open jobs on the chain when it starts.
   */
  state?: DutyState | undefined;
  /** Whether the duty scans the chain for this wallet's open jobs at start. Default true. */
  discover?: boolean | undefined;
}

const USDC = /^\d+(\.\d{1,6})?$/;
const AGENT = z.string().min(1).describe("The agent's did:aip (did:aip:eip155:<chain>:<registry>:<id>) or its https URL.");

type Structured = Record<string, unknown>;

/**
 * Square as an MCP server, for a client such as Claude Desktop or Cursor.
 *
 * Seven tools. `square_agent` looks an agent up by DID or URL and says what
 * it offers and for how much; `square_hire` escrows a job for it on
 * SquareJob and gives it the task over A2A; `square_task` and `square_job`
 * read where the task and the job stand afterwards; `square_dispatch` hands
 * a funded job's task to the agent again when the hire could not, and
 * `square_refund` takes an expired job's escrow back (square#351);
 * `square_call` pays a capability per call through x402, for an agent that
 * serves it that way.
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
  // for its own receipts. The duty's ticks go through the same queue, since
  // they sign from the same wallet.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // The duty runs for as long as the server does, from the start: its jobs
  // outlive the tool call that funded them by the challenge window, and a
  // restart in between must not lose them (square#348), so the run begins
  // by recovering what the state holds and what the chain shows this wallet
  // still has open, before any hire.
  let duty: ComplianceDuty | undefined;
  const dutyStop = new AbortController();
  if (options.compliance && canSpend) {
    const compliance = options.compliance;
    duty = new ComplianceDuty({
      client,
      policy: compliance.policy,
      prover: compliance.prover,
      // The screener the client funds through is the one the duty asks
      // before a release (square#369): one URL, both ends of the job.
      screener: client.screener,
      onEvent: compliance.onEvent,
      serialize: serially,
      state: compliance.state,
      discover: compliance.discover,
    });
    const run = duty.run(dutyStop.signal, { intervalMs: compliance.intervalMs }).catch((error: unknown) => {
      compliance.onEvent?.({ type: "error", jobId: null, error: error instanceof Error ? error : new Error(String(error)) });
    });
    const previousClose = server.server.onclose;
    server.server.onclose = () => {
      dutyStop.abort();
      void run;
      previousClose?.();
    };
  }
  const trackFunded = (jobId: bigint, capability: string, budget: bigint): void => {
    duty?.track(jobId, capability, budget);
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
        const compliance = await complianceOf(client, id, record.status, duty?.jobs().some((job) => job.jobId === id) ?? false);
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
          ...(compliance ? { compliance } : {}),
        };
        return ok(
          [
            `Job ${jobId}: ${content.status as string}.`,
            `client ${record.client}, provider ${record.provider}, evaluator ${record.evaluator}`,
            `budget ${content.budget as string} USDC, expires ${content.expiredAt as string}`,
            `deliverable ${record.deliverable}${agentId === null ? ", no agent bound" : `, bound to agent ${agentId}`}`,
            ...(compliance ? [`compliance: ${compliance.summary}`] : []),
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
        jobId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("An Open job this wallet already created for the agent, to budget, fund and dispatch instead of creating another: what a hire whose funding failed part way leaves behind."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ agent, capability, input, budget, expiresInDays, jobId: resume }) =>
      serially(async () => {
        let profile: AgentProfile;
        try {
          profile = await lookup(agent);
        } catch (error) {
          return failed(error);
        }
        let result: HireResult;
        try {
          result = await hire({
            client,
            a2a,
            profile,
            capability,
            input,
            budget,
            expiresInDays,
            jobDays: options.jobDays,
            callerDid,
            taskTimeoutMs,
            pollIntervalMs,
            jobId: resume === undefined ? undefined : BigInt(resume),
            onFunded: (job) => trackFunded(job.jobId, capability, job.budget),
          });
        } catch (error) {
          if (error instanceof HireRefusedError && error.stage === "funding") {
            const opened = error.transactions.createJob !== undefined || resume !== undefined;
            return failed(
              error,
              undefined,
              { transactions: error.transactions, ...(opened ? { hint: "The job is Open with nothing escrowed; call square_hire again with its jobId to budget, fund and dispatch it rather than opening another." } : {}) },
            );
          }
          return failed(error);
        }
        const { jobId, taskId } = result;
        const content: Structured = {
          jobId: jobId.toString(),
          taskId,
          agent: profile.did,
          provider: result.provider,
          capability,
          budget: formatUnits(result.budget, 6),
          transactions: result.transactions,
          ...(result.task ? taskContent(result.task) : {}),
        };
        const head =
          `Job ${jobId} funded with ${formatUnits(result.budget, 6)} USDC for ${profile.name || profile.did}, capability ${capability}.` +
          (duty ? ` This server keeps the job's compliance proof current and releases it when the window closes.` : "");
        return dispatched(result.dispatch, result, head, content, jobId, taskId);
      }),
  );

  const dispatched = (outcome: DispatchOutcome["dispatch"], result: DispatchOutcome, head: string, content: Structured, jobId: bigint, taskId: string): CallToolResult => {
    switch (outcome) {
      case "delivered":
        return ok(`${head}\n${describeTask(result.task!)}`, content);
      case "failed":
        return failed(
          `${head}\n${describeTask(result.task!)}\nThe escrow stays on job ${jobId}; once the job expires, square_refund takes it back to this wallet.`,
          undefined,
          content,
        );
      case "working":
        return ok(
          `${head}\nTask ${taskId} is still running after ${Math.round(taskTimeoutMs / 1000)} s. Poll it with square_task; ` +
            `the escrow waits for the agent's submit, and square_refund takes it back if the job expires undelivered.`,
          { ...content, task: { state: TaskState.Working } },
        );
      case "undispatched":
        return failed(
          result.reason ?? "the task could not be dispatched",
          `${head}\nThe task could not be handed to the agent. The escrow stays on job ${jobId}: try again later with square_dispatch, ` +
            "or once the job expires take the escrow back with square_refund",
          content,
        );
    }
  };

  server.registerTool(
    "square_dispatch",
    {
      title: "Hand a funded job's task to its agent again",
      description:
        "For a job square_hire funded but could not hand over (the agent did not answer): gives the agent the task again over A2A, under the same task id, " +
        "and waits for it the way square_hire does. Spends nothing; the escrow is already on the job. The job has to be Funded, this wallet's, and for the agent named.",
      inputSchema: {
        agent: AGENT,
        jobId: z.string().regex(/^\d+$/).describe("The job square_hire returned."),
        capability: z.string().min(1).describe("The capability the job was hired for."),
        input: z.string().describe("The work, as it was given to square_hire."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ agent, jobId, capability, input }) =>
      serially(async () => {
        let profile: AgentProfile;
        try {
          profile = await lookup(agent);
        } catch (error) {
          return failed(error);
        }
        if (profile.a2aEndpoint === undefined) return failed(`${profile.did} advertises no A2A endpoint`);
        const id = BigInt(jobId);
        let record;
        try {
          record = await client.getJobRecord(id);
        } catch (error) {
          return failed(error, `job ${jobId} could not be read`);
        }
        if (record.status !== JobStatus.Funded) return failed(`job ${jobId} is ${JOB_STATUS_NAMES[record.status as JobStatusValue] ?? record.status}, not Funded; only a funded job has a task to hand over`);
        if (record.client.toLowerCase() !== client.account.toLowerCase()) return failed(`job ${jobId} belongs to ${record.client}, not this wallet`);
        if (record.provider.toLowerCase() !== profile.provider.toLowerCase()) return failed(`job ${jobId} is for provider ${record.provider}, not ${profile.name || profile.did}'s ${profile.provider}`);
        const taskId = `square-job-${id}`;
        const result = await dispatch({ a2a, endpoint: profile.a2aEndpoint, taskId, capability, input, callerDid, jobId: id, taskTimeoutMs, pollIntervalMs });
        const content: Structured = { jobId, taskId, agent: profile.did, provider: profile.provider, capability, budget: formatUnits(record.budget, 6), ...(result.task ? taskContent(result.task) : {}) };
        return dispatched(result.dispatch, result, `Job ${jobId} (${formatUnits(record.budget, 6)} USDC in escrow) handed to ${profile.name || profile.did} again.`, content, id, taskId);
      }),
  );

  server.registerTool(
    "square_refund",
    {
      title: "Take an expired job's escrow back",
      description:
        "For a job this wallet funded that expired with nothing delivered: claims the refund on SquareJob and withdraws it to this wallet. " +
        "Before the expiry it says when the escrow becomes claimable and spends nothing. An Open job holds no escrow and needs no refund.",
      inputSchema: { jobId: z.string().regex(/^\d+$/).describe("Decimal job id, as square_hire returned it.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId }) =>
      serially(async () => {
        const id = BigInt(jobId);
        let record;
        try {
          record = await client.getJobRecord(id);
        } catch (error) {
          return failed(error, `job ${jobId} could not be read`);
        }
        const status = JOB_STATUS_NAMES[record.status as JobStatusValue] ?? String(record.status);
        if (record.client.toLowerCase() !== client.account.toLowerCase()) return failed(`job ${jobId} belongs to ${record.client}, not this wallet`);
        if (record.status === JobStatus.Open) return ok(`Job ${jobId} is Open: nothing is escrowed on it, so there is nothing to refund.`, { jobId, status });
        if (record.status !== JobStatus.Funded && record.status !== JobStatus.Submitted) return failed(`job ${jobId} is ${status}; the escrow has already been settled`);
        const { timestamp } = await client.publicClient.getBlock();
        if (timestamp < BigInt(record.expiredAt)) {
          return ok(
            `Job ${jobId} is ${status} and expires ${iso(record.expiredAt)}; the escrow (${formatUnits(record.budget, 6)} USDC) becomes claimable then, if nothing is delivered first.`,
            { jobId, status, expiredAt: iso(record.expiredAt), budget: formatUnits(record.budget, 6), claimable: false },
          );
        }
        let claimed: Hex;
        try {
          claimed = (await client.claimRefund(id)).hash;
        } catch (error) {
          return failed(error, `job ${jobId}'s refund could not be claimed`);
        }
        let withdrawn: Hex | undefined;
        try {
          withdrawn = (await client.withdraw()).hash;
        } catch (error) {
          return failed(error, `the refund of job ${jobId} is credited to this wallet on the ledger (claimed in ${claimed}) but could not be withdrawn`, { jobId, transactions: { claimRefund: claimed } });
        }
        return ok(`Job ${jobId}: refund claimed in ${claimed} and withdrawn to ${client.account} in ${withdrawn}.`, { jobId, status: "Expired", transactions: { claimRefund: claimed, withdraw: withdrawn } });
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

/**
 * Where a job stands with the gate: nothing when the stack has no module or
 * the job is settled; otherwise the bound proof against the release the
 * chain would make now (square#335). Read for `square_job`, so a model that
 * hired sees whether the release is provable before the window closes.
 */
async function complianceOf(client: SquareClient, jobId: bigint, status: number, tracked: boolean): Promise<(Structured & { summary: string }) | null> {
  if (status !== JobStatus.Funded && status !== JobStatus.Submitted) return null;
  const tolerance = await client.complianceTolerance();
  if (tolerance === null) return null;
  const [bound, facts] = await Promise.all([client.complianceProofOf(jobId), releaseFacts(client, jobId)]);
  const state = proofState(bound, facts, tolerance / 2n);
  // square#369: on a hook that screens, the payee's record decides the
  // release as much as the proof does; the duty holds the job while it is
  // missing, and the report says so beside the proof.
  const screening = await client.screeningOf(facts.payee, await client.screening(facts.hook));
  const screened =
    screening.state === "no-screening"
      ? {}
      : {
          payeeScreening: screening.state,
          screeningSummary:
            screening.state === "cleared"
              ? `the payee ${facts.payee} is cleared by the screening registry`
              : screening.state === "sanctioned"
                ? `a fresh screening record says the payee ${facts.payee} is designated; the release will go back to the client`
                : `the payee ${facts.payee} has no fresh screening record; ${tracked ? "this server holds the release until one lands" : "a release now would pay the client back"}`,
        };
  const base = { payee: facts.payee, net: formatUnits(facts.amount, 6), spentToday: formatUnits(facts.dailySpentBefore, 6), toleranceSeconds: tolerance.toString(), tracked, ...screened };
  const withScreening = (summary: string) => ("screeningSummary" in screened ? `${summary}; ${screened.screeningSummary}` : summary);
  switch (state.kind) {
    case "none":
      return {
        ...base,
        proof: "none",
        summary: withScreening(
          tracked
            ? "the hook holds a module and no proof is bound yet; this server binds one when the window is within half the tolerance of closing, and releases the job itself"
            : "the hook holds a module and no proof is bound; a release now would pay the client back",
        ),
      };
    case "malformed":
      return { ...base, proof: "malformed", summary: withScreening("the bound proof is malformed") };
    case "current":
      return { ...base, proof: "current", proofAgeSeconds: state.age.toString(), summary: withScreening(`a current proof is bound, ${state.age}s old, naming payee ${facts.payee} and net ${base.net} USDC`) };
    case "stale":
      return { ...base, proof: "stale", proofAgeSeconds: state.age.toString(), stale: state.reasons, summary: withScreening(`the bound proof is stale: ${state.reasons.join("; ")}`) };
  }
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
