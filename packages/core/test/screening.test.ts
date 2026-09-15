import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, type Abi, type Address, type PublicClient, type TransactionReceipt } from "viem";
import {
  createScreenerClient,
  createSquareClient,
  deploymentFor,
  PartyNotClearedError,
  ScreenerError,
  squareHookAbi,
  type Screener,
  type SquareWalletClient,
} from "../src/index.js";

/**
 * square#368: on a hook that screens, `fund` reads both parties' screening
 * before it sends, asks the client's screener for whoever lacks a fresh
 * record, and refuses before sending when a party is still not cleared. The
 * chain here is a table of answers; what is asserted is which reads and
 * writes happen, and in what order, for each state the registry can be in.
 */
const deployment = deploymentFor(31337);
const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const provider = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const registry = "0x9A676e781A523b5d0C0e43731313A708CB607508" as const;
const screenerAddress = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;
const NOW = 1_800_000_000n;
const MAX_AGE = 3_600n;

interface Call {
  functionName: string;
  args: readonly unknown[];
  address: Address;
}

interface Record {
  screener: Address;
  screenedAt: bigint;
  sanctioned: boolean;
}

interface ChainOptions {
  /** What the hook's `screening()` answers; "absent" for a hook deployed before the function existed. */
  screening?: Address | "absent";
  records?: Partial<globalThis.Record<string, Record>>;
  /** Screener addresses the registry still trusts. Default: `screenerAddress`. */
  trusted?: Address[];
}

function chain(options: ChainOptions = {}) {
  const records = new Map<string, Record>(Object.entries(options.records ?? {}).map(([k, v]) => [k.toLowerCase(), v!]));
  const trusted = new Set((options.trusted ?? [screenerAddress]).map((a) => a.toLowerCase()));
  const reads: Call[] = [];
  const sent: Call[] = [];
  const isCleared = (subject: string) => {
    const record = records.get(subject.toLowerCase());
    return record !== undefined && !record.sanctioned && NOW - record.screenedAt <= MAX_AGE && trusted.has(record.screener.toLowerCase());
  };
  const publicClient = {
    chain: { id: deployment.chainId },
    getChainId: async () => deployment.chainId,
    getBlock: async () => ({ timestamp: NOW, number: 100n }),
    readContract: async (request: Call & { abi: Abi }) => {
      reads.push(request);
      const subject = request.args?.[0] as string | undefined;
      switch (request.functionName) {
        case "getJobRecord":
          return { status: 0, client, provider, hook: deployment.squareHook, budget: 5_000_000n };
        case "screening":
          if (options.screening === "absent") {
            throw new ContractFunctionExecutionError(
              new ContractFunctionRevertedError({ abi: squareHookAbi, functionName: "screening", message: "execution reverted" }) as never,
              { abi: squareHookAbi, functionName: "screening", contractAddress: deployment.squareHook },
            );
          }
          return options.screening ?? registry;
        case "isCleared":
          return isCleared(subject!);
        case "screeningOf": {
          const record = records.get(subject!.toLowerCase());
          return record ?? { screener: "0x0000000000000000000000000000000000000000", screenedAt: 0n, sanctioned: false, source: `0x${"0".repeat(64)}`, evidence: `0x${"0".repeat(64)}` };
        }
        case "maxAge":
          return MAX_AGE;
        case "isScreener":
          return trusted.has(subject!.toLowerCase());
        case "allowance":
          return 10_000_000n;
        default:
          throw new Error(`unexpected read ${request.functionName}`);
      }
    },
    simulateContract: async (request: Call & { abi: Abi }) => ({ request: { ...request, abi: request.abi.filter((i) => i.type === "function") } }),
    waitForTransactionReceipt: async () => ({ status: "success", transactionHash: txHash, blockNumber: 12n, gasUsed: 21_000n, logs: [] }) as unknown as TransactionReceipt,
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: client },
    chain: { id: deployment.chainId },
    writeContract: async (request: Call) => {
      sent.push(request);
      return txHash;
    },
  } as unknown as SquareWalletClient;
  /** The SDK client on this chain, with the screener it was given, if any. */
  const square = (screener?: Screener) => createSquareClient({ publicClient, walletClient, deployment, ...(screener ? { screener } : {}) });
  /** A screener that records what it was asked and writes a clean record for each subject, the way the service does before it answers. */
  const clearing = (asked: Address[][]): Screener => ({
    async screen(subjects) {
      asked.push([...subjects]);
      for (const subject of subjects) records.set(subject.toLowerCase(), { screener: screenerAddress, screenedAt: NOW, sanctioned: false });
    },
  });
  return { square, reads, sent, records, clearing, names: () => reads.map((r) => r.functionName) };
}

const fresh = (sanctioned = false): Record => ({ screener: screenerAddress, screenedAt: NOW - 10n, sanctioned });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("fund on a hook that screens", () => {
  it("sends when both parties are cleared, having read the client first, as the hook does", async () => {
    const { square, sent, names } = chain({ records: { [client]: fresh(), [provider]: fresh() } });
    await square().fund(1n, 5_000_000n);
    expect(sent.map((s) => s.functionName)).toEqual(["fund"]);
    expect(names()).toEqual(["getJobRecord", "screening", "isCleared", "isCleared", "allowance"]);
  });

  it("refuses before sending when a party has no record and there is no screener to ask, naming the party", async () => {
    const { square, sent, names } = chain({ records: { [client]: fresh() } });
    const error = await rejection(square().fund(1n, 5_000_000n));
    expect(error).toBeInstanceOf(PartyNotClearedError);
    expect(error).toMatchObject({ jobId: 1n, role: "provider", subject: provider, state: "unscreened" });
    expect((error as Error).message).toBe(
      `the provider ${provider} is not cleared to fund job 1: the registry holds no fresh, clean record for it and no screener is configured to ask; nothing was sent`,
    );
    // Nothing went out: no approval, no simulation, no send.
    expect(sent).toEqual([]);
    expect(names()).not.toContain("allowance");
  });

  it("names the client before the provider when neither is cleared", async () => {
    const { square } = chain();
    const error = await rejection(square().fund(1n, 5_000_000n));
    expect(error).toMatchObject({ role: "client", subject: client });
  });

  it("asks the screener for whoever lacks a record, once, and sends once the registry clears them", async () => {
    const asked: Address[][] = [];
    const c = chain({ records: { [client]: fresh() } });
    await c.square(c.clearing(asked)).fund(1n, 5_000_000n);
    expect(asked).toEqual([[provider]]);
    expect(c.sent.map((s) => s.functionName)).toEqual(["fund"]);
    // The provider was read twice: before the screening and after it.
    expect(c.reads.filter((r) => r.functionName === "isCleared").map((r) => r.args[0])).toEqual([client, provider, provider]);
  });

  it("asks for a record that is older than maxAge, since a fresh screening replaces it", async () => {
    const asked: Address[][] = [];
    const c = chain({ records: { [client]: fresh(), [provider]: { screener: screenerAddress, screenedAt: NOW - MAX_AGE - 1n, sanctioned: false } } });
    await c.square(c.clearing(asked)).fund(1n, 5_000_000n);
    expect(asked).toEqual([[provider]]);
    expect(c.sent.map((s) => s.functionName)).toEqual(["fund"]);
  });

  it("asks for a record whose screener the registry no longer trusts", async () => {
    const asked: Address[][] = [];
    const revoked = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as const;
    const c = chain({ records: { [client]: fresh(), [provider]: { screener: revoked, screenedAt: NOW - 10n, sanctioned: false } } });
    await c.square(c.clearing(asked)).fund(1n, 5_000_000n);
    expect(asked).toEqual([[provider]]);
  });

  it("does not ask for a party a fresh record says is designated: screening again would answer the same", async () => {
    const asked: Address[][] = [];
    const c = chain({ records: { [client]: fresh(), [provider]: fresh(true) } });
    const error = await rejection(c.square(c.clearing(asked)).fund(1n, 5_000_000n));
    expect(error).toMatchObject({ role: "provider", state: "sanctioned" });
    expect((error as Error).message).toContain("a fresh screening record says it is designated");
    expect(asked).toEqual([]);
    expect(c.sent).toEqual([]);
  });

  it("refuses after the screener was asked when the registry still does not clear the party", async () => {
    const asked: Address[][] = [];
    const c = chain({ records: { [client]: fresh() } });
    const silent: Screener = {
      async screen(subjects) {
        asked.push([...subjects]);
      },
    };
    const error = await rejection(c.square(silent).fund(1n, 5_000_000n));
    expect(error).toMatchObject({ role: "provider", state: "unscreened" });
    expect((error as Error).message).toContain("the screener was asked and the registry still holds no fresh, clean record for it");
    expect(asked).toEqual([[provider]]);
    expect(c.sent).toEqual([]);
  });

  it("lets a screener's own failure through, unsent", async () => {
    const c = chain({ records: { [client]: fresh() } });
    const down: Screener = {
      async screen() {
        throw new ScreenerError("the screener at http://screener could not be reached: ECONNREFUSED", undefined);
      },
    };
    await expect(c.square(down).fund(1n, 5_000_000n)).rejects.toBeInstanceOf(ScreenerError);
    expect(c.sent).toEqual([]);
  });

  it("reads nobody when the hook holds no registry", async () => {
    const { square, sent, names } = chain({ screening: "0x0000000000000000000000000000000000000000" });
    await square().fund(1n, 5_000_000n);
    expect(sent.map((s) => s.functionName)).toEqual(["fund"]);
    expect(names()).toEqual(["getJobRecord", "screening", "allowance"]);
  });

  it("treats a hook that predates screening() as one that screens nobody, and asks it once", async () => {
    const { square, sent, names } = chain({ screening: "absent" });
    const one = square();
    await one.fund(1n, 5_000_000n);
    await one.fund(2n, 5_000_000n);
    expect(sent.map((s) => s.functionName)).toEqual(["fund", "fund"]);
    expect(names().filter((n) => n === "screening")).toHaveLength(1);
  });
});

describe("screeningOf", () => {
  it("answers no-screening without a registry, and the registry's three states otherwise", async () => {
    const none = chain({ screening: "0x0000000000000000000000000000000000000000" });
    expect(await none.square().screeningOf(client)).toEqual({ subject: client, state: "no-screening", registry: null });
    const c = chain({
      records: {
        [client]: fresh(),
        [provider]: fresh(true),
        [screenerAddress]: { screener: screenerAddress, screenedAt: NOW - MAX_AGE - 1n, sanctioned: true },
      },
    });
    const square = c.square();
    expect(await square.screeningOf(client)).toMatchObject({ state: "cleared", registry });
    expect(await square.screeningOf(provider)).toMatchObject({ state: "sanctioned" });
    // A designation past maxAge is not a standing "no": it is a missing screening.
    expect(await square.screeningOf(screenerAddress)).toMatchObject({ state: "unscreened" });
    expect(await square.screeningOf(registry)).toMatchObject({ state: "unscreened" });
  });
});

describe("createScreenerClient", () => {
  const requests: { url: string; body: unknown }[] = [];
  const answering = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("posts the addresses to /screen, sixteen to a request", async () => {
    requests.length = 0;
    const screener = createScreenerClient({ url: "http://screener:3012/", fetch: answering(200, { screenings: [] }) });
    const subjects = Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    await screener.screen(subjects);
    expect(requests.map((r) => r.url)).toEqual(["http://screener:3012/screen", "http://screener:3012/screen"]);
    expect((requests[0]!.body as { addresses: string[] }).addresses).toHaveLength(16);
    expect((requests[1]!.body as { addresses: string[] }).addresses).toHaveLength(4);
  });

  it("turns a refusal into a ScreenerError carrying the status and the reason", async () => {
    const screener = createScreenerClient({ url: "http://screener:3012", fetch: answering(503, { error: "the source did not flag the canary" }) });
    const error = await rejection(screener.screen([client]));
    expect(error).toBeInstanceOf(ScreenerError);
    expect(error).toMatchObject({ status: 503, message: "the screener refused the request (503): the source did not flag the canary" });
  });

  it("says when the screener could not be reached", async () => {
    const screener = createScreenerClient({
      url: "http://screener:3012",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const error = await rejection(screener.screen([client]));
    expect(error).toMatchObject({ status: undefined, message: "the screener at http://screener:3012 could not be reached: ECONNREFUSED" });
  });

  it("gives up after timeoutMs", async () => {
    const screener = createScreenerClient({
      url: "http://screener:3012",
      timeoutMs: 20,
      fetch: ((_url: unknown, init?: RequestInit) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch,
    });
    const error = await rejection(screener.screen([client]));
    expect(error).toMatchObject({ message: "the screener at http://screener:3012 did not answer within 20 ms" });
  });
});
