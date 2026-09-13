import { A2AServer, type CapabilityHandler, type TaskSettlement } from "@squaresdk/a2a";
import type { JobStatus as A2AJobStatus } from "@squaresdk/a2a";
import { hashDeliverable, JobStatus, specDescription, type SquareClient } from "@squaresdk/core";
import { Hono } from "hono";
import { isAddressEqual, type Address, type Hex } from "viem";
import { deployment, OWNER } from "./fakes.js";

export interface FakeRecord {
  client: Address;
  provider: Address;
  evaluator: Address;
  status: number;
  budget: bigint;
  createdAt: number;
  expiredAt: number;
  fundedAt: number;
  submittedAt: number;
  deliverable: Hex;
  description: string;
}

const ZERO: Hex = `0x${"00".repeat(32)}`;
const EVALUATOR: Address = "0x0000000000000000000000000000000000000EEE";
const hashOf = (label: string, n: number): Hex => `0x${Buffer.from(`${label}:${n}`).toString("hex").padEnd(64, "0")}`;

/**
 * SquareJob in a Map: what the MCP server calls on the client, and what an
 * agent's settlement reads back. The writes are logged in order, because the
 * order is the point of the hire tool.
 */
export function fakeChain(
  options: { account?: Address | undefined; balance?: bigint | undefined; horizon?: number | undefined; now?: (() => number) | undefined; wallet?: boolean | undefined } = {},
) {
  const account = options.account ?? OWNER;
  const records = new Map<bigint, FakeRecord>();
  const agents = new Map<bigint, bigint>();
  const writes: string[] = [];
  const state = { balance: options.balance ?? 1_000_000_000n, counter: 0n, txs: 0 };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tx = (label: string) => {
    state.txs += 1;
    return { hash: hashOf(label, state.txs), receipt: {}, events: [] };
  };
  const record = (id: bigint): FakeRecord => {
    const found = records.get(id);
    if (!found) throw new Error("InvalidJob()");
    return found;
  };

  const client = {
    deployment,
    publicClient: { getBlock: async () => ({ timestamp: BigInt(now()) }) },
    walletClient: options.wallet === false ? undefined : {},
    get account() {
      if (options.wallet === false) throw new Error("no wallet");
      return account;
    },
    async getJobRecord(id: bigint) {
      return { ...record(id) };
    },
    async agentOf(id: bigint) {
      record(id);
      return agents.get(id) ?? null;
    },
    async usdcBalance() {
      return state.balance;
    },
    async settlementHorizon() {
      return options.horizon ?? 4 * 86_400 + 3_600;
    },
    async createJob(params: { provider: Address; expiredAt: bigint; spec?: unknown; description?: string }) {
      state.counter += 1n;
      const id = state.counter;
      records.set(id, {
        client: account,
        provider: params.provider,
        evaluator: EVALUATOR,
        status: JobStatus.Open,
        budget: 0n,
        createdAt: now(),
        expiredAt: Number(params.expiredAt),
        fundedAt: 0,
        submittedAt: 0,
        deliverable: ZERO,
        description: params.spec !== undefined ? specDescription(params.spec) : (params.description ?? ""),
      });
      writes.push(`createJob(${id}, provider=${params.provider}, expiredAt=${params.expiredAt})`);
      return { ...tx("create"), jobId: id };
    },
    async setBudget(id: bigint, amount: bigint) {
      const job = record(id);
      if (job.status !== JobStatus.Open) throw new Error("WrongStatus()");
      job.budget = amount;
      writes.push(`setBudget(${id}, ${amount})`);
      return tx("budget");
    },
    async fund(id: bigint, expected: bigint) {
      const job = record(id);
      if (job.status !== JobStatus.Open) throw new Error("WrongStatus()");
      if (job.budget !== expected) throw new Error("BudgetMismatch()");
      if (state.balance < expected) throw new Error("ERC20InsufficientBalance");
      state.balance -= expected;
      job.status = JobStatus.Funded;
      job.fundedAt = now();
      writes.push(`fund(${id}, ${expected})`);
      return tx("fund");
    },
  };

  /** The provider's settlement over the same records: what `squareSettlement` does, without the chain. */
  const settlementFor = (provider: Address, agentId: bigint, minimum?: (capability: string) => bigint | undefined): TaskSettlement => ({
    async admit(jobId, task) {
      const id = BigInt(jobId);
      const job = records.get(id);
      if (!job) return { ok: false, reason: `job ${jobId} could not be read: InvalidJob()` };
      if (job.status !== JobStatus.Funded) return { ok: false, reason: `job ${jobId} is Open, not Funded` };
      if (!isAddressEqual(job.provider, provider)) return { ok: false, reason: `job ${jobId} is funded for provider ${job.provider}, not this agent` };
      const floor = minimum?.(task.capability);
      if (floor !== undefined && job.budget < floor) return { ok: false, reason: `job ${jobId} is funded with ${job.budget} but ${task.capability} costs ${floor}` };
      return { ok: true };
    },
    async deliver(jobId, content) {
      const id = BigInt(jobId);
      const job = record(id);
      const deliverable = hashDeliverable(content);
      job.status = JobStatus.Submitted;
      job.submittedAt = now();
      job.deliverable = deliverable;
      agents.set(id, agentId);
      const { hash } = tx("submit");
      writes.push(`submit(${id}, ${deliverable})`);
      return { deliverable, reference: hash };
    },
    async jobStatus(jobId) {
      return record(BigInt(jobId)).status as A2AJobStatus;
    },
  });

  return { client: client as unknown as SquareClient, records, writes, state, settlementFor };
}

/**
 * An agent the way `@squaresdk/agent` serves one, over the fake chain: the
 * card at the well-known path and `POST /a2a` in front of an `A2AServer`
 * with a settlement. Returned as a Hono app, for a fetch that routes to it.
 */
export function fakeAgent(options: {
  card: unknown;
  provider: Address;
  agentId: bigint;
  handlers: Record<string, CapabilityHandler>;
  chain: ReturnType<typeof fakeChain>;
  minimum?: ((capability: string) => bigint | undefined) | undefined;
}): { app: Hono; a2a: A2AServer } {
  const a2a = new A2AServer({ handlers: options.handlers, settlement: options.chain.settlementFor(options.provider, options.agentId, options.minimum) });
  const app = new Hono();
  app.get("/.well-known/agent-registration.json", (c) => c.json(options.card as object));
  app.post("/a2a", async (c) => c.json(await a2a.handle(await c.req.json())));
  return { app, a2a };
}

/** A fetch that hands each origin to a Hono app, and 404s the rest. */
export function fetchRouting(apps: Record<string, Hono>): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const app = apps[new URL(url).origin];
    if (!app) return new Response("no such origin", { status: 404 });
    // A Request carries its own method and body; a string needs the init.
    return input instanceof Request ? app.request(input) : app.request(url, init);
  };
}
