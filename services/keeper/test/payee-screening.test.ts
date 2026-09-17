import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, zeroAddress, type Address, type TransactionReceipt } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deploymentFor, type SquareClient } from "@squaresdk/core";
import { jobs, keeperActions, migrate, MIGRATIONS_DIR, pgliteDatabase, type Database } from "@squaresdk/data";
import { createLogger } from "@squaresdk/observability";
import { Keeper } from "../src/run.js";
import { assertScreenerForHook, assertScreenerUrl, payeeScreening, SCREENER_MAX_ADDRESSES } from "../src/screening.js";

type ScreeningOptions = Parameters<typeof payeeScreening>[0];

const chainId = 31337;
const budget = 1_000_000_000n;
const challengeEnd = 1_000n;
const now = 2_000n;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;
const silent = createLogger({ service: "test", version: "0", sink: () => {} });
const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;

// Nothing listens on port 1, and viem's retries are off, so every read fails at
// once with the transport error a real RPC outage produces.
const unreachableRpc = createPublicClient({ chain: foundry, transport: http("http://127.0.0.1:1", { retryCount: 0 }) });

describe("an RPC failure is not a hook that screens nobody", () => {
  it("returns the failure for the job instead of letting it be finalized", async () => {
    const screen = payeeScreening({
      client: { getJobRecord: async () => ({ hook: fresh() }) } as unknown as ScreeningOptions["client"],
      publicClient: unreachableRpc,
      screener: { url: "http://127.0.0.1:1", allowPrivate: true },
    });
    const outcome = (await screen([7n])).get(7n);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/HTTP request failed/);
  });
});

describe("a keeper with no screener", () => {
  const registryReading = (cleared: boolean, registry: Address, market: Address, payee: Address): ScreeningOptions["publicClient"] =>
    ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "screening") return registry;
        if (functionName === "claimMarket") return market;
        if (functionName === "payeeOf") return payee;
        if (functionName === "isCleared") return cleared;
        if (functionName === "screeningOf") return { subject: payee, sanctioned: false, screenedAt: 0n, source: zeroAddress, evidence: zeroAddress, screener: zeroAddress };
        if (functionName === "maxAge") return 3_600n;
        throw new Error(`the registry was asked ${functionName}, which this reading does not answer`);
      },
      getBlock: async () => ({ timestamp: now }),
    }) as unknown as ScreeningOptions["publicClient"];

  it("refuses to start against a hook that screens, naming the registry", async () => {
    const registry = fresh();
    const publicClient = { readContract: async () => registry } as unknown as ScreeningOptions["publicClient"];

    await expect(assertScreenerForHook(publicClient, fresh())).rejects.toThrow(new RegExp(registry, "i"));
  });

  it("starts against a hook it cannot read at all, and says the chain is what it could not read", async () => {
    const unreadable = await assertScreenerForHook(unreachableRpc, fresh());

    expect(unreadable).toBeInstanceOf(Error);
    expect((unreadable as Error).message).toMatch(/HTTP request failed/);
  });

  it("holds a payee the registry does not clear, having asked nobody to screen it", async () => {
    const payee = fresh();
    const screen = payeeScreening({
      client: { getJobRecord: async () => ({ hook: fresh() }) } as unknown as ScreeningOptions["client"],
      publicClient: registryReading(false, fresh(), fresh(), payee),
    });

    expect((await screen([9n])).get(9n)).toEqual({ proceed: false, state: "unscreened", payee });
  });

  it("finalizes a payee the registry already clears", async () => {
    const payee = fresh();
    const screen = payeeScreening({
      client: { getJobRecord: async () => ({ hook: fresh() }) } as unknown as ScreeningOptions["client"],
      publicClient: registryReading(true, fresh(), fresh(), payee),
    });

    expect((await screen([9n])).get(9n)).toEqual({ proceed: true, state: "cleared", payee });
  });
});

describe("a tick's payees go to the screener together", () => {
  let server: Server;
  let url: string;
  const requests: string[][] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        requests.push((JSON.parse(body) as { addresses: string[] }).addresses);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("asks about each address once, and at most SCREENER_MAX_ADDRESSES in a request", async () => {
    const registry = fresh();
    const market = fresh();
    const payees = Array.from({ length: 36 }, fresh);
    // Forty jobs, four of them paying a payee another job already pays.
    const jobIds = Array.from({ length: 40 }, (_, index) => BigInt(index));
    const payeeOf = (jobId: bigint): Address => payees[Number(jobId) % payees.length] as Address;
    const publicClient = {
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "screening") return registry;
        if (functionName === "claimMarket") return market;
        if (functionName === "payeeOf") return payeeOf(args?.[0] as bigint);
        if (functionName === "isCleared") return true;
        throw new Error(`nothing else is read for a cleared payee, but ${functionName} was`);
      },
      getBlock: async () => ({ timestamp: now }),
    } as unknown as ScreeningOptions["publicClient"];
    const screen = payeeScreening({
      client: { getJobRecord: async () => ({ hook: fresh() }) } as unknown as ScreeningOptions["client"],
      publicClient,
      screener: { url, allowPrivate: true },
    });

    const outcomes = await screen(jobIds);

    expect(outcomes.size).toBe(40);
    expect([...outcomes.values()].every((outcome) => !(outcome instanceof Error) && outcome.state === "cleared")).toBe(true);
    expect(SCREENER_MAX_ADDRESSES).toBe(16);
    expect(requests.map((addresses) => addresses.length)).toEqual([16, 16, 4]);
    expect(requests.flat()).toHaveLength(36);
    expect(new Set(requests.flat())).toEqual(new Set(payees));
  });
});

describe("where the keeper may send a screening request", () => {
  it("never to a link-local address, even with private addresses allowed", async () => {
    await expect(assertScreenerUrl("http://169.254.169.254/screen", true)).rejects.toThrow(/link_local/);
    // The same address written as one number, which URL parsing normalises.
    await expect(assertScreenerUrl("http://2852039166/screen", true)).rejects.toThrow(/link_local/);
  });

  it("to a loopback or private address only when that is allowed", async () => {
    await expect(assertScreenerUrl("http://127.0.0.1:3012/screen")).rejects.toThrow(/address_not_public/);
    await expect(assertScreenerUrl("http://127.0.0.1:3012/screen", true)).resolves.toBeUndefined();
    await expect(assertScreenerUrl("http://10.0.0.5:3012/screen", true)).resolves.toBeUndefined();
  });
});

describe("one job's screening failing does not stop the tick", () => {
  let db: Database;

  beforeAll(async () => {
    db = await pgliteDatabase();
    await migrate(db, MIGRATIONS_DIR, "up");
  });

  afterAll(async () => {
    await db.close();
  });

  it("journals that job's failure and still finalizes the job after it", async () => {
    const evaluator = deploymentFor(chainId).keeperEvaluator;
    const party = fresh();
    for (const jobId of [1n, 2n]) {
      await jobs.upsert(db, {
        chainId,
        jobId,
        client: party,
        provider: party,
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
    // Job 1's hook has to be read from a chain that does not answer; job 2 has
    // no hook, so its screening needs nothing from the chain.
    const hookOf = (jobId: bigint): Address => (jobId === 1n ? fresh() : zeroAddress);
    const sent: bigint[] = [];
    const client = {
      deployment: deploymentFor(chainId),
      publicClient: { getGasPrice: async () => 20_000_000_000n },
      getJobRecord: async (jobId: bigint) => ({ status: 2, budget, evaluatorFeeBP: 50, expiredAt: 9_000_000_000n, hook: hookOf(jobId) }),
      isDisputed: async () => false,
      challengeEndsAt: async () => Number(challengeEnd),
      finalize: async (jobId: bigint) => {
        sent.push(jobId);
        const receipt = { status: "success", transactionHash: txHash, blockNumber: 12n, gasUsed: 21_000n, logs: [] } as unknown as TransactionReceipt;
        return { hash: txHash, receipt, events: [] };
      },
    } as unknown as SquareClient;
    const keeper = new Keeper({
      db,
      chainId,
      client,
      logger: silent,
      minimumMarginBps: 2_000,
      defaultFinalizeGas: 420_000n,
      defaultFinalizeDecidedGas: 470_000n,
      recordExpiries: false,
      screenPayees: payeeScreening({ client, publicClient: unreachableRpc, screener: { url: "http://127.0.0.1:1", allowPrivate: true } }),
    });

    const report = await keeper.tick(now);

    expect(report.finalized).toEqual([2n]);
    expect(sent).toEqual([2n]);
    const failure = (await keeperActions.recent(db, chainId)).find((row) => row.jobId === 1n);
    expect(failure?.action).toBe("finalize");
    expect(failure?.txHash).toBeNull();
    expect(failure?.reason).toContain("screening the payee failed");
  });
});
