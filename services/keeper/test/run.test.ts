import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deploymentFor, TransactionRevertedError, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger } from "@squaresdk/observability";
import type { TransactionReceipt } from "viem";
import { Keeper } from "../src/run.js";

const chainId = 31337;
const jobId = 1n;
const budget = 1_000_000_000n;
const challengeEnd = 1_000n;
const now = 2_000n;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;
const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const silent = createLogger({ service: "test", version: "0", sink: () => {} });

function revertedReceipt(): TransactionReceipt {
  return { status: "reverted", transactionHash: txHash, blockNumber: 12n, gasUsed: 21_000n, logs: [] } as unknown as TransactionReceipt;
}

function successReceipt(): TransactionReceipt {
  return { status: "success", transactionHash: txHash, blockNumber: 12n, gasUsed: 21_000n, logs: [] } as unknown as TransactionReceipt;
}

function fakeClient(finalize: () => Promise<{ hash: typeof txHash; receipt: TransactionReceipt; events: [] }>): SquareClient {
  return {
    deployment: deploymentFor(chainId),
    publicClient: { getGasPrice: async () => 20_000_000_000n },
    getJobRecord: async () => ({ status: 2, budget, evaluatorFeeBP: 50, expiredAt: 9_000_000_000n }),
    isDisputed: async () => false,
    challengeEndsAt: async () => Number(challengeEnd),
    finalize,
  } as unknown as SquareClient;
}

function keeperOver(client: SquareClient, db: Database): Keeper {
  return new Keeper({
    db,
    chainId,
    client,
    logger: silent,
    minimumMarginBps: 2_000,
    defaultFinalizeGas: 420_000n,
    defaultFinalizeDecidedGas: 470_000n,
    recordExpiries: false,
  });
}

describe("the keeper journals what the chain accepted", () => {
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
    await db.query("delete from jobs");
    await jobs.upsert(db, {
      chainId,
      jobId,
      client: address,
      provider: address,
      evaluator: address,
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
    });
  });

  it("records a failure, not a success, when the finalize send reverts on chain", async () => {
    const keeper = keeperOver(
      fakeClient(async () => {
        throw new TransactionRevertedError(txHash, revertedReceipt());
      }),
      db,
    );

    const report = await keeper.tick(now);
    expect(report.finalized).toEqual([]);

    const journal = await keeperActions.recent(db, chainId);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.action).toBe("finalize");
    expect(journal[0]?.txHash).toBeNull();
    expect(journal[0]?.gasUsed).toBeNull();
    expect(journal[0]?.reason).toContain("reverted");
  });

  it("records a success when the finalize send lands", async () => {
    const keeper = keeperOver(
      fakeClient(async () => ({ hash: txHash, receipt: successReceipt(), events: [] })),
      db,
    );

    const report = await keeper.tick(now);
    expect(report.finalized).toEqual([jobId]);

    const journal = await keeperActions.recent(db, chainId);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.txHash).toBe(txHash);
    expect(journal[0]?.reason).toBeNull();
  });
});
