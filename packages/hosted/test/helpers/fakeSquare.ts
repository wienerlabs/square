import { A2AServer, WellKnownCache, type CapabilityHandler, type JobStatus as A2AJobStatus, type TaskSettlement } from "@squaresdk/a2a";
import { registrationFile, type CardCapability, type RegistrationFile } from "@squaresdk/agent";
import { deploymentFor, hashDeliverable, JobStatus, specDescription, type SquareClient } from "@squaresdk/core";
import type { DidResolutionResult } from "@squaresdk/did-resolver";
import type { DidResolverLike } from "@squaresdk/mcp";
import { Hono } from "hono";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

export const CHAIN_ID = 31337;
export const deployment = deploymentFor(CHAIN_ID);
export const REGISTRY = deployment.identityRegistry.toLowerCase();
export const HOST_WALLET: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil 2: the hosted agent
export const SUB_WALLET: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // anvil 3: the agent it hires
export const didOf = (agentId: number | bigint) => `did:aip:eip155:${CHAIN_ID}:${REGISTRY}:${agentId}`;

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
 * SquareJob and PolicyRegistry in a Map, as seen from one wallet: what
 * `hire` and `PolicyAllowance` call on a client, and what a provider's
 * settlement reads back. Writes are logged in order.
 */
export function fakeSquare(options: { account?: Address; balance?: bigint; horizon?: number; now?: () => number } = {}) {
  const account = options.account ?? HOST_WALLET;
  const records = new Map<bigint, FakeRecord>();
  const agents = new Map<bigint, bigint>();
  const policies = new Map<string, { commitment: Hex; dailyLimit: bigint; updatedAt: bigint; epoch: bigint }>();
  const spent = new Map<string, bigint>();
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
    walletClient: {},
    get account() {
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
    async policyOf(poster: Address) {
      return policies.get(poster.toLowerCase()) ?? { commitment: ZERO, dailyLimit: 0n, updatedAt: 0n, epoch: 0n };
    },
    // No module in the hook's slot: a hire asks nothing more of the registry than the allowance does.
    async complianceModule() {
      return null;
    },
    async complianceTolerance() {
      return null;
    },
    // No screening registry either (square#35): fund asks nobody, the duty holds nothing.
    async screening() {
      return null;
    },
    async screeningOf(subject: Address) {
      return { subject, state: "no-screening", registry: null };
    },
    async spentToday(poster: Address) {
      return spent.get(poster.toLowerCase()) ?? 0n;
    },
    async setPolicy(commitment: Hex, dailyLimit: bigint) {
      const key = account.toLowerCase();
      const previous = policies.get(key);
      policies.set(key, { commitment, dailyLimit, updatedAt: BigInt(now()), epoch: (previous?.epoch ?? 0n) + 1n });
      writes.push(`setPolicy(${dailyLimit})`);
      return tx("policy");
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
      writes.push(`createJob(${id}, provider=${params.provider})`);
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

  /** The evaluator's side, for a test: release a submitted job and count it against the poster, the way the registry does. */
  const release = (id: bigint) => {
    const job = record(id);
    job.status = JobStatus.Completed;
    const key = job.client.toLowerCase();
    spent.set(key, (spent.get(key) ?? 0n) + job.budget);
  };

  /** A provider's settlement over the same records: what `squareSettlement` does, without the chain. */
  const settlementFor = (provider: Address, agentId: bigint, minimum?: (capability: string) => bigint | undefined): TaskSettlement => ({
    async admit(jobId, task) {
      const job = records.get(BigInt(jobId));
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

  return { client: client as unknown as SquareClient, records, writes, state, settlementFor, release };
}

export interface CardShape {
  name?: string;
  url?: string;
  agentId?: bigint;
  capabilities?: CardCapability[];
}

/** A card the way `@squaresdk/agent` writes one. */
export function card(shape: CardShape = {}): RegistrationFile {
  const agentId = shape.agentId ?? 2n;
  return registrationFile({
    name: shape.name ?? "Scribe",
    description: "Summarises what it is given.",
    url: shape.url ?? "https://scribe.example",
    did: didOf(agentId),
    agentId,
    agentRegistry: `eip155:${CHAIN_ID}:${REGISTRY}`,
    token: deployment.usdc.toLowerCase(),
    network: `eip155:${CHAIN_ID}`,
    capabilities: shape.capabilities ?? [{ id: "text.summarize", description: "Summarise a document.", price: "0.10" }],
  });
}

/** A resolution the way `AipDidResolver` shapes one, for an agent whose wallet is its owner. */
export function resolution(did: string, owner: Address, endpoint: string): DidResolutionResult {
  return {
    didDocument: {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      controller: `did:pkh:eip155:${CHAIN_ID}:${getAddress(owner)}`,
      verificationMethod: [
        { id: `${did}#owner`, type: "EcdsaSecp256k1RecoveryMethod2020", controller: did, blockchainAccountId: `eip155:${CHAIN_ID}:${getAddress(owner)}` },
      ],
      authentication: [`${did}#owner`],
      capabilityInvocation: [`${did}#owner`],
      assertionMethod: [`${did}#owner`],
      service: [{ id: `${did}#a2a`, type: "A2A", serviceEndpoint: endpoint }],
    },
    didResolutionMetadata: { contentType: "application/did+ld+json" },
    didDocumentMetadata: { versionId: "1" },
  };
}

export function resolverOf(table: Record<string, DidResolutionResult>): DidResolverLike {
  return {
    async resolve(did) {
      return table[did] ?? { didDocument: null, didResolutionMetadata: { error: "notFound", errorMessage: `no ${did}` }, didDocumentMetadata: {} };
    },
  };
}

/**
 * An agent the way `@squaresdk/agent` serves one, over the fake chain: the
 * card at the well-known path and `POST /a2a` in front of an `A2AServer`
 * with a settlement.
 */
export function fakeAgent(options: {
  card: unknown;
  provider: Address;
  agentId: bigint;
  handlers: Record<string, CapabilityHandler>;
  chain: ReturnType<typeof fakeSquare>;
}): { app: Hono; a2a: A2AServer } {
  const a2a = new A2AServer({ handlers: options.handlers, settlement: options.chain.settlementFor(options.provider, options.agentId) });
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
    return input instanceof Request ? app.request(input) : app.request(url, init);
  };
}

export function cardsOver(fetch: typeof globalThis.fetch): WellKnownCache {
  return new WellKnownCache({ fetch });
}
