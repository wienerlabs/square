import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, keeperJobState, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger, createMetrics, type Metrics } from "@squaresdk/observability";
import type { Address, TransactionReceipt } from "viem";
import { Keeper } from "../src/run.js";

const chainId = 31337;
const budget = 5_000_000n;
const net = 4_925_000n;
const challengeEnd = 1_000n;
const now = 2_000n;
const grace = 3_600n;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;
const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const payee = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const module = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e" as Address;
const evaluator = deploymentFor(chainId).keeperEvaluator;
const silent = createLogger({ service: "test", version: "0", sink: () => {} });

function receipt(gasUsed: bigint): TransactionReceipt {
  return { status: "success", transactionHash: txHash, blockNumber: 12n, gasUsed, logs: [] } as unknown as TransactionReceipt;
}

interface Chain {
  proofs: Map<string, `0x${string}`>;
  unverifiable: Set<string>;
  accepts: Set<string>;
  completed: Set<string>;
  finalized: bigint[];
  previews: bigint[];
  events: Array<{ contract: string; eventName: string; args: Record<string, unknown> }>;
  onFinalize?: (jobId: bigint) => void;
}

function fakeChain(): Chain {
  return {
    proofs: new Map(),
    unverifiable: new Set(),
    accepts: new Set(),
    completed: new Set(),
    finalized: [],
    previews: [],
    events: [],
  };
}

function fakeClient(chain: Chain, gasUsed = 1_052_107n): SquareClient {
  return {
    deployment: deploymentFor(chainId),
    publicClient: { getGasPrice: async () => 1_000_000_000n },
    getJobRecord: async (jobId: bigint) => ({
      status: chain.completed.has(jobId.toString()) ? 3 : 2,
      budget,
      evaluatorFeeBP: 50,
      expiredAt: 9_000_000_000n,
      client,
    }),
    isDisputed: async () => false,
    challengeEndsAt: async () => Number(challengeEnd),
    payeeOf: async () => payee,
    netPayout: async () => net,
    complianceProofOf: async (jobId: bigint) => chain.proofs.get(jobId.toString()) ?? "0x",
    proofState: async (jobId: bigint) => {
      const key = jobId.toString();
      if ((chain.proofs.get(key) ?? "0x") === "0x") return "missing";
      return chain.unverifiable.has(key) ? "unverifiable" : "decidable";
    },
    previewRelease: async ({ jobId }: { jobId: bigint }) => {
      chain.previews.push(jobId);
      return chain.accepts.has(jobId.toString());
    },
    finalize: async (jobId: bigint) => {
      chain.finalized.push(jobId);
      chain.completed.add(jobId.toString());
      chain.onFinalize?.(jobId);
      return { hash: txHash, receipt: receipt(gasUsed), events: chain.events };
    },
  } as unknown as SquareClient;
}

function keeperOver(db: Database, client: SquareClient, gated: boolean, metrics?: Metrics): Keeper {
  return new Keeper({
    db,
    chainId,
    client,
    logger: silent,
    ...(metrics === undefined ? {} : { metrics }),
    minimumMarginBps: 2_000,
    defaultFinalizeGas: 1_060_000n,
    defaultFinalizeDecidedGas: 1_110_000n,
    ...(gated ? { complianceModule: module } : {}),
    proofGraceSeconds: grace,
    recordExpiries: false,
  });
}

async function mirror(db: Database, jobId: bigint): Promise<void> {
  await jobs.upsert(db, {
    chainId,
    jobId,
    client,
    provider: payee,
    evaluator,
    hook: null,
    description: "",
    budget,
    status: 2,
    expiredAt: 9_000_000_000n,
    createdAt: 1n,
    fundedAt: 2n,
    submittedAt: 3n,
    challengeEnd,
    platformFeeBp: 100,
    evaluatorFeeBp: 50,
    deliverable: null,
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: null,
    updatedBlock: 1n,
    refundReason: null,
  });
}

describe("a job the module would refuse", () => {
  let db: Database;

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("delete from keeper_actions");
    await db.query("delete from keeper_job_state");
    await db.query("delete from jobs");
  });

  it("is held, not failed, and cranked on the tick its proof becomes current", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    const keeper = keeperOver(db, fakeClient(chain), true);

    const first = await keeper.tick(now);
    expect(first.finalized).toEqual([]);
    expect(first.held).toEqual([{ jobId: 1n, reason: "proofStale" }]);
    expect(first.skipped).toEqual([{ jobId: 1n, reason: "proofStale" }]);
    expect(chain.finalized).toEqual([]);
    expect(await keeperActions.recent(db, chainId)).toEqual([]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldReason).toBe("proofStale");
    expect((await keeperJobState.get(db, chainId, 1n))?.heldSince).toBe(now);

    const again = await keeper.tick(now + 15n);
    expect(again.held).toEqual([{ jobId: 1n, reason: "proofStale" }]);
    expect(chain.previews).toEqual([1n, 1n]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldSince).toBe(now);

    chain.accepts.add("1");
    const third = await keeper.tick(now + 30n);
    expect(third.finalized).toEqual([1n]);
    expect(third.held).toEqual([]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldReason).toBeNull();
  });

  it("costs no retry attempt, so the tick after a hold sends without waiting out a backoff", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    const keeper = keeperOver(db, fakeClient(chain), true);

    await keeper.tick(now);
    chain.accepts.add("1");
    const next = await keeper.tick(now + 1n);

    expect(next.finalized).toEqual([1n]);
    expect(next.skipped.find((entry) => entry.reason === "backoff")).toBeUndefined();
  });

  it("is cranked anyway once the grace runs out, so a stale proof cannot stall the keeper", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    const keeper = keeperOver(db, fakeClient(chain, 493_581n), true);

    await keeper.tick(now);
    const inside = await keeper.tick(now + grace - 1n);
    expect(inside.finalized).toEqual([]);
    expect(inside.held).toEqual([{ jobId: 1n, reason: "proofStale" }]);

    const past = await keeper.tick(now + grace);
    expect(past.finalized).toEqual([1n]);
    expect(past.held).toEqual([]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldReason).toBeNull();
  });

  it("never cranks a job with no proof, because the evaluator refuses to settle one", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    const keeper = keeperOver(db, fakeClient(chain), true);

    const first = await keeper.tick(now);
    expect(first.held).toEqual([{ jobId: 1n, reason: "noProof" }]);
    expect(first.finalized).toEqual([]);
    expect(chain.previews).toEqual([]);

    const wayPastTheGrace = await keeper.tick(now + grace * 100n);
    expect(wayPastTheGrace.finalized).toEqual([]);
    expect(wayPastTheGrace.held).toEqual([{ jobId: 1n, reason: "noProof" }]);

    chain.proofs.set("1", "0xbeef");
    chain.accepts.add("1");
    const bound = await keeper.tick(now + grace * 100n + 1n);
    expect(bound.finalized).toEqual([1n]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldReason).toBeNull();
  });

  it("holds a proof that does not verify for the same reason, since there is still nothing to decide", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    chain.unverifiable.add("1");
    const keeper = keeperOver(db, fakeClient(chain), true);

    const tick = await keeper.tick(now);
    expect(tick.held).toEqual([{ jobId: 1n, reason: "noProof" }]);
    expect(tick.finalized).toEqual([]);
  });

  it("turns a ProofRequired revert into a hold rather than a failed attempt", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    chain.accepts.add("1");
    const client_ = fakeClient(chain);
    const refusing = {
      ...client_,
      finalize: async () => {
        throw new Error('The contract function "finalize" reverted. Error: ProofRequired(1, 1)');
      },
    } as unknown as SquareClient;
    const keeper = keeperOver(db, refusing, true);

    const tick = await keeper.tick(now);

    expect(tick.finalized).toEqual([]);
    expect(tick.held).toEqual([{ jobId: 1n, reason: "noProof" }]);
    expect((await keeperJobState.get(db, chainId, 1n))?.heldReason).toBe("noProof");
    const rows = await keeperActions.recent(db, chainId, 10);
    expect(rows.filter((row) => row.jobId === 1n)).toEqual([]);
  });

  it("holds the second job of one client whose counter the first release moved, and cranks it on the next tick", async () => {
    await mirror(db, 1n);
    await mirror(db, 2n);
    const chain = fakeChain();
    chain.accepts.add("1");
    chain.accepts.add("2");
    chain.proofs.set("1", "0xbeef");
    chain.proofs.set("2", "0xbeef");
    chain.onFinalize = () => chain.accepts.delete("2");
    const keeper = keeperOver(db, fakeClient(chain), true);

    const first = await keeper.tick(now);

    expect(first.finalized).toEqual([1n]);
    expect(first.held).toEqual([{ jobId: 2n, reason: "proofStale" }]);
    expect(chain.finalized).toEqual([1n]);
    expect((await keeperJobState.get(db, chainId, 2n))?.heldReason).toBe("proofStale");

    chain.accepts.add("2");
    const second = await keeper.tick(now + 15n);

    expect(second.finalized).toEqual([2n]);
    expect(second.held).toEqual([]);
    expect(chain.finalized).toEqual([1n, 2n]);
  });

  it("is not looked at on a stack with no module, which keeps today's path", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    const keeper = keeperOver(db, fakeClient(chain), false);

    const report = await keeper.tick(now);

    expect(report.finalized).toEqual([1n]);
    expect(report.held).toEqual([]);
    expect(chain.previews).toEqual([]);
    expect(await keeperJobState.listHeld(db, chainId)).toEqual([]);
  });

  it("releases a hold whose job left the mirror, so the count on /status and /health stays honest", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    const metrics = createMetrics({ service: "test", defaultMetrics: false });
    const keeper = keeperOver(db, fakeClient(chain), true, metrics);

    await keeper.tick(now);
    expect(await keeperJobState.countHeld(db, chainId)).toEqual({ noProof: 1 });

    await db.query("update jobs set status = 5");
    await keeper.tick(now + 15n);

    expect(await keeperJobState.countHeld(db, chainId)).toEqual({});
    expect(await keeperJobState.listHeld(db, chainId)).toEqual([]);
  });
});

describe("a release the module refused", () => {
  let db: Database;

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
  });

  afterAll(async () => {
    await db.close();
  });

  it("is counted by reason with the amount that went back to the client", async () => {
    await mirror(db, 1n);
    const chain = fakeChain();
    chain.proofs.set("1", "0xbeef");
    chain.accepts.add("1");
    chain.events.push(
      {
        contract: "ComplianceModule",
        eventName: "ReleaseRefused",
        args: { jobId: 1n, statement: `0x${"00".repeat(32)}`, reason: `0x${Buffer.from("daily_spent_before").toString("hex").padEnd(64, "0")}` },
      },
      { contract: "SquareHook", eventName: "ComplianceChecked", args: { jobId: 1n, payee, amount: net, verified: false } },
    );
    const metrics = createMetrics({ service: "test", defaultMetrics: false });
    const keeper = keeperOver(db, fakeClient(chain), true, metrics);

    const report = await keeper.tick(now);

    expect(report.finalized).toEqual([1n]);
    expect(metrics.snapshot().releaseRefusals).toBe(1);
    expect(metrics.snapshot().releaseRefusalsWithAmount).toBe(1);
    const exported = await metrics.registry.metrics();
    expect(exported).toContain('square_release_refused_total{reason="daily_spent_before"');
  });
});
