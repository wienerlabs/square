import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Log, type PublicClient } from "viem";
import { deploymentFor, squareJobAbi, type SquareDeployment } from "@squaresdk/core";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, quarantinedEvents, type Database, type QueryResult } from "@squaresdk/data";
import { Indexer, rangeTooLarge } from "../src/sync.js";
import { startBlockFor } from "../src/config.js";

const CHAIN = 31337;
const deployment = deploymentFor(CHAIN);
const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const provider = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

interface Recorded {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

function recordingLogger(sink: Recorded[]) {
  const at = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    sink.push({ level, event, fields });
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => recordingLogger(sink) } as never;
}

function jobCreatedLog(jobId: bigint, blockNumber: bigint, logIndex: number): Log {
  return {
    address: deployment.squareJob,
    topics: encodeEventTopics({ abi: squareJobAbi, eventName: "JobCreated", args: { jobId, client, provider } }),
    data: encodeAbiParameters(parseAbiParameters("address, uint256, address"), [
      deployment.keeperEvaluator,
      1_900_000_000n,
      deployment.squareHook,
    ]),
    blockNumber,
    logIndex,
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: 0,
    blockHash: `0x${"cd".repeat(32)}`,
    removed: false,
  } as Log;
}

function clientRefusingWideRanges(head: bigint, widest: bigint, calls: Array<[bigint, bigint]>, logs: Log[] = []): PublicClient {
  return {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > widest) {
        throw Object.assign(new Error("requested range too large"), { code: -32012 });
      }
      return logs.filter((log) => (log.blockNumber ?? 0n) >= fromBlock && (log.blockNumber ?? 0n) <= toBlock);
    },
  } as unknown as PublicClient;
}

async function openDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

function journalThatRefuses(db: Database, logIndex: number): Database {
  const wrap = (inner: Database): Database => ({
    query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      if (text.includes("insert into job_events") && params?.[2] === logIndex) {
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return inner.query<T>(text, params);
    },
    transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return inner.transaction((tx) => fn(wrap(tx)));
    },
    close: () => inner.close(),
  });
  return wrap(db);
}

function indexerOn(db: Database, publicClient: PublicClient, logs: Recorded[], batchBlocks: bigint, startBlock: bigint): Indexer {
  return new Indexer({
    db,
    publicClient,
    chainId: CHAIN,
    deployment,
    startBlock,
    batchBlocks,
    logger: recordingLogger(logs),
  });
}

describe("a block range the node refuses", () => {
  it("is halved until it fits, and the cursor still reaches the end of the batch", async () => {
    const db = await openDatabase();
    try {
      const calls: Array<[bigint, bigint]> = [];
      const logs: Recorded[] = [];
      const indexer = indexerOn(db, clientRefusingWideRanges(100_000n, 20_000n, calls), logs, 50_000n, 1n);
      await indexer.start();

      const result = await indexer.syncOnce();

      expect(result?.toBlock).toBe(50_000n);
      expect(indexer.lastIndexedBlock).toBe(50_000n);
      expect(calls[0]).toEqual([1n, 50_000n]);
      expect(calls.filter(([from, to]) => to - from + 1n <= 20_000n).length).toBeGreaterThan(0);
      const splits = logs.filter((line) => line.event === "indexer.batch_split");
      expect(splits.length).toBeGreaterThan(0);
      expect(String(splits[0]?.fields["reason"])).toContain("BATCH_BLOCKS");
    } finally {
      await db.close();
    }
  });

  it("gives up on a single block rather than splitting forever", async () => {
    const db = await openDatabase();
    try {
      const calls: Array<[bigint, bigint]> = [];
      const indexer = indexerOn(db, clientRefusingWideRanges(4n, 0n, calls), [], 4n, 1n);
      await indexer.start();

      await expect(indexer.syncOnce()).rejects.toThrow(/range too large/);
      expect(calls.length).toBeLessThan(20);
    } finally {
      await db.close();
    }
  });

  it("recognises the refusal by code and by wording, and nothing else", () => {
    expect(rangeTooLarge(Object.assign(new Error("boom"), { code: -32012 }))).toBe(true);
    expect(rangeTooLarge(new Error("requested range too large"))).toBe(true);
    expect(rangeTooLarge({ cause: { message: "block range is too wide" } })).toBe(true);
    expect(rangeTooLarge(new Error("nonce too low"))).toBe(false);
    expect(rangeTooLarge(undefined)).toBe(false);
  });
});

describe("an event set aside at the journal stage", () => {
  it("is still listed after a restart, and the count the health check reads is not zero", async () => {
    const db = await openDatabase();
    try {
      const events = [jobCreatedLog(1n, 10n, 0), jobCreatedLog(2n, 10n, 1)];
      const first = indexerOn(journalThatRefuses(db, 1), clientRefusingWideRanges(10n, 1_000n, [], events), [], 1_000n, 1n);
      await first.start();

      const result = await first.syncOnce();

      expect(result?.quarantined).toBe(1);
      expect(first.quarantinedEvents).toHaveLength(1);
      expect(first.quarantinedEvents[0]?.stage).toBe("journal");
      expect(await quarantinedEvents.count(db, CHAIN)).toBe(1);

      const restarted = indexerOn(db, clientRefusingWideRanges(10n, 1_000n, [], events), [], 1_000n, 1n);
      await restarted.start();

      expect(restarted.quarantinedEvents).toHaveLength(1);
      expect(restarted.quarantinedEvents[0]).toMatchObject({ stage: "journal", logIndex: 1, eventName: "JobCreated" });
    } finally {
      await db.close();
    }
  });
});

describe("the block the indexer starts from", () => {
  const configured = process.env["START_BLOCK"];

  afterEach(() => {
    if (configured === undefined) delete process.env["START_BLOCK"];
    else process.env["START_BLOCK"] = configured;
  });

  const recorded: SquareDeployment = { ...deployment, startBlock: 61_249_969n };

  it("comes from the deployment record when the environment is silent", () => {
    delete process.env["START_BLOCK"];
    expect(startBlockFor(recorded)).toBe(61_249_969n);
  });

  it("comes from START_BLOCK when that is set", () => {
    process.env["START_BLOCK"] = "100";
    expect(startBlockFor(recorded)).toBe(100n);
    expect(startBlockFor(deployment)).toBe(100n);
  });

  it("refuses to scan from genesis when neither names a block", () => {
    delete process.env["START_BLOCK"];
    expect(() => startBlockFor(deployment)).toThrow(/genesis is not a default/);
  });
});
