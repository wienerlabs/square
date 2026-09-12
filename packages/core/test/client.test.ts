import { formatDid } from "@squaresdk/did-resolver";
import { describe, expect, it } from "vitest";
import { decodeErrorResult, encodeErrorResult, type Abi, type PublicClient, type TransactionReceipt } from "viem";
import {
  AgentIdMismatchError,
  connectSquareClient,
  createSquareClient,
  DeploymentChainMismatchError,
  deploymentFor,
  DidScopeMismatchError,
  encodeSubmitOptParams,
  squareHookAbi,
  squareJobAbi,
  TransactionRevertedError,
  withSquareErrors,
  type SquareWalletClient,
} from "../src/index.js";

const deployment = deploymentFor(31337);
const sender = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;
const deliverable = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const otherRegistry = "0x000000000000000000000000000000000000dEaD" as const;

interface FakeOptions {
  status?: "success" | "reverted";
  publicChainId?: number | undefined;
  walletChainId?: number | undefined;
  /** What eth_chainId answers. Defaults to the deployment's chain, the honest endpoint. */
  endpointChainId?: number;
}

interface SimulatedCall {
  functionName: string;
  args: readonly unknown[];
  abi: Abi;
}

function fakeChain(options: FakeOptions, key: "publicChainId" | "walletChainId"): { id: number } | undefined {
  const declared = key in options ? options[key] : deployment.chainId;
  return declared === undefined ? undefined : { id: declared };
}

function fakes(options: FakeOptions = {}) {
  const calls: SimulatedCall[] = [];
  const receipt = {
    status: options.status ?? "success",
    transactionHash: txHash,
    blockNumber: 12n,
    gasUsed: 21_000n,
    logs: [],
  } as unknown as TransactionReceipt;
  const reads: SimulatedCall[] = [];
  const sent: SimulatedCall[] = [];
  let chainIdCalls = 0;
  const publicClient = {
    chain: fakeChain(options, "publicChainId"),
    getChainId: async () => {
      chainIdCalls += 1;
      return options.endpointChainId ?? deployment.chainId;
    },
    simulateContract: async (request: SimulatedCall) => {
      calls.push(request);
      // viem hands back a request whose abi is cut down to the one function.
      return { request: { ...request, abi: request.abi.filter((i) => i.type === "function") } };
    },
    readContract: async (request: SimulatedCall) => {
      reads.push(request);
      return 0n;
    },
    waitForTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: sender },
    chain: fakeChain(options, "walletChainId"),
    writeContract: async (request: SimulatedCall) => {
      sent.push(request);
      return txHash;
    },
  } as unknown as SquareWalletClient;
  return { calls, reads, sent, publicClient, walletClient, chainIdCalls: () => chainIdCalls };
}

function square(options: FakeOptions = {}) {
  const { calls, reads, sent, publicClient, walletClient, chainIdCalls } = fakes(options);
  return { calls, reads, sent, chainIdCalls, client: createSquareClient({ publicClient, walletClient, deployment }) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("write checks the receipt status", () => {
  it("throws when a transaction passes simulation and reverts once mined", async () => {
    const { client } = square({ status: "reverted" });
    const error = await rejection(client.withdraw());
    expect(error).toBeInstanceOf(TransactionRevertedError);
    const reverted = error as TransactionRevertedError;
    expect(reverted.hash).toBe(txHash);
    expect(reverted.receipt.status).toBe("reverted");
    expect(reverted.message).toContain(txHash);
  });

  it("still returns the result when the receipt reports success", async () => {
    const { client } = square();
    await expect(client.withdraw()).resolves.toMatchObject({ hash: txHash, events: [] });
  });
});

describe("the client and the deployment agree on the chain", () => {
  it("rejects a deployment that is not for the chain the clients declare", () => {
    const { publicClient, walletClient } = fakes({ publicChainId: 5042002, walletChainId: 5042002 });
    const error = (() => {
      try {
        createSquareClient({ publicClient, walletClient, deployment });
        return undefined;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(DeploymentChainMismatchError);
    const mismatch = error as DeploymentChainMismatchError;
    expect(mismatch.deploymentChainId).toBe(31337);
    expect(mismatch.clientChainId).toBe(5042002);
    expect(mismatch.message).toContain("31337");
    expect(mismatch.message).toContain("5042002");
  });

  it("rejects a wallet client that is on another chain than the public client", () => {
    const { publicClient, walletClient } = fakes({ walletChainId: 5042002 });
    expect(() => createSquareClient({ publicClient, walletClient, deployment })).toThrow(DeploymentChainMismatchError);
  });

  it("accepts clients that declare the deployment chain", () => {
    const { publicClient, walletClient } = fakes();
    expect(createSquareClient({ publicClient, walletClient, deployment }).deployment.chainId).toBe(31337);
  });

  it("accepts clients that carry no chain when the deployment is explicit", () => {
    const { publicClient, walletClient } = fakes({ publicChainId: undefined, walletChainId: undefined });
    expect(createSquareClient({ publicClient, walletClient, deployment }).deployment.chainId).toBe(31337);
  });
});

describe("submit keeps the did inside the deployment scope", () => {
  const inScope = formatDid(deployment.chainId, deployment.identityRegistry, 7n);

  it("binds the agent named by a did that is scoped to this deployment", async () => {
    const { calls, client } = square();
    await client.submit({ jobId: 1n, deliverable, did: inScope });
    expect(calls[0]?.functionName).toBe("submit");
    expect(calls[0]?.args[2]).toBe(encodeSubmitOptParams({ agentId: 7n }));
  });

  it("rejects a did that names another chain", async () => {
    const { client } = square();
    const error = await rejection(client.submit({ jobId: 1n, deliverable, did: formatDid(5042002, deployment.identityRegistry, 7n) }));
    expect(error).toBeInstanceOf(DidScopeMismatchError);
    expect((error as DidScopeMismatchError).message).toContain("5042002");
    expect((error as DidScopeMismatchError).message).toContain("31337");
  });

  it("rejects a did that names another identity registry", async () => {
    const { client } = square();
    const error = await rejection(client.submit({ jobId: 1n, deliverable, did: formatDid(deployment.chainId, otherRegistry, 7n) }));
    expect(error).toBeInstanceOf(DidScopeMismatchError);
    expect((error as DidScopeMismatchError).message).toContain(deployment.identityRegistry);
  });

  it("rejects an agentId that contradicts the did", async () => {
    const { client } = square();
    const error = await rejection(client.submit({ jobId: 1n, deliverable, agentId: 9n, did: inScope }));
    expect(error).toBeInstanceOf(AgentIdMismatchError);
    expect((error as AgentIdMismatchError).agentId).toBe(9n);
    expect((error as AgentIdMismatchError).didAgentId).toBe(7n);
  });

  it("accepts an agentId that agrees with the did", async () => {
    const { calls, client } = square();
    await client.submit({ jobId: 1n, deliverable, agentId: 7n, did: inScope });
    expect(calls[0]?.args[2]).toBe(encodeSubmitOptParams({ agentId: 7n }));
  });

  it("sends empty optParams when no agent is named", async () => {
    const { calls, client } = square();
    await client.submit({ jobId: 1n, deliverable });
    expect(calls[0]?.args[2]).toBe("0x");
  });
});

describe("the endpoint is asked which chain it is", () => {
  // The constructor compares the deployment to the chain the clients declare,
  // and both come from the caller, so a wrong RPC_URL passed it: every read
  // answered from another chain at Arc addresses, and a local-key wallet
  // signed without viem checking either (#269).
  it("refuses to read from an endpoint on another chain, before the read", async () => {
    const { client, reads } = square({ endpointChainId: 5042002 });
    const error = await rejection(client.jobCounter());
    expect(error).toBeInstanceOf(DeploymentChainMismatchError);
    const mismatch = error as DeploymentChainMismatchError;
    expect(mismatch.source).toBe("endpoint");
    expect(mismatch.deploymentChainId).toBe(31337);
    expect(mismatch.clientChainId).toBe(5042002);
    expect(mismatch.message).toContain("eth_chainId");
    expect(reads).toHaveLength(0);
  });

  it("refuses to write through an endpoint on another chain, before the simulation", async () => {
    const { client, calls, sent } = square({ endpointChainId: 5042002 });
    const error = await rejection(client.withdraw());
    expect(error).toBeInstanceOf(DeploymentChainMismatchError);
    expect((error as DeploymentChainMismatchError).source).toBe("endpoint");
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("asks once, not on every call", async () => {
    const { client, chainIdCalls } = square();
    await client.jobCounter();
    await client.netPayout(1n);
    await client.withdraw();
    expect(chainIdCalls()).toBe(1);
  });

  it("retries the check after it failed in transport", async () => {
    const { publicClient, walletClient } = fakes();
    let attempts = 0;
    (publicClient as unknown as { getChainId: () => Promise<number> }).getChainId = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return deployment.chainId;
    };
    const client = createSquareClient({ publicClient, walletClient, deployment });
    expect(await rejection(client.jobCounter())).toBeInstanceOf(Error);
    await client.jobCounter();
    expect(attempts).toBe(2);
  });

  it("connectSquareClient fails at construction instead of on first use", async () => {
    const { publicClient, walletClient } = fakes({ endpointChainId: 5042002 });
    const error = await rejection(connectSquareClient({ publicClient, walletClient, deployment }));
    expect(error).toBeInstanceOf(DeploymentChainMismatchError);
    expect((error as DeploymentChainMismatchError).source).toBe("endpoint");
  });

  it("the declared-chain check still names its own comparison", () => {
    const { publicClient, walletClient } = fakes({ publicChainId: 5042002, walletChainId: 5042002 });
    const error = (() => {
      try {
        createSquareClient({ publicClient, walletClient, deployment });
        return undefined;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();
    expect((error as DeploymentChainMismatchError).source).toBe("declared");
    expect((error as DeploymentChainMismatchError).message).toContain("declares");
  });
});

describe("a revert raised behind the contract being called still decodes", () => {
  // SquareJob re-raises its hook's revert data verbatim, and viem decodes a
  // revert by looking its selector up in the ABI it was handed for the call.
  // The two errors SquareHook exists to raise are the two a submit caller can
  // trigger, and with squareJobAbi alone both came back as "Unable to decode
  // signature 0x2e0a79a4" (#268).
  const hookRevert = encodeErrorResult({
    abi: squareHookAbi,
    errorName: "AgentNotOwnedByProvider",
    args: [7n, sender],
  });

  it("squareJobAbi alone cannot name the hook's error, and that is the bug", () => {
    expect(() => decodeErrorResult({ abi: squareJobAbi, data: hookRevert })).toThrow(/not found on ABI/);
  });

  it("the ABI the client simulates with can", () => {
    const decoded = decodeErrorResult({ abi: withSquareErrors(squareJobAbi), data: hookRevert });
    expect(decoded.errorName).toBe("AgentNotOwnedByProvider");
    expect(decoded.args).toEqual([7n, sender]);
  });

  it("submit simulates with the hook's errors on board", async () => {
    const { client, calls } = square();
    await client.submit({ jobId: 1n, deliverable });
    const names = calls[0]!.abi.filter((i) => i.type === "error").map((i) => (i as { name: string }).name);
    expect(names).toContain("AgentNotOwnedByProvider");
    expect(names).toContain("ValidationRequestMismatch");
    expect(names).toContain("InvalidJob");
  });

  it("the write leg carries the same errors, not the one-function ABI simulation hands back", async () => {
    const { client, sent } = square();
    await client.submit({ jobId: 1n, deliverable });
    const names = sent[0]!.abi.filter((i) => i.type === "error").map((i) => (i as { name: string }).name);
    expect(names).toContain("AgentNotOwnedByProvider");
  });

  it("payeeOf reads with SquareJob's errors on board, since ClaimMarket reaches InvalidJob", async () => {
    const { client, reads } = square();
    await client.payeeOf(99n);
    const names = reads[0]!.abi.filter((i) => i.type === "error").map((i) => (i as { name: string }).name);
    expect(names).toContain("InvalidJob");
    expect(reads[0]!.functionName).toBe("payeeOf");
  });

  it("keeps every function of the contract the call is for and adds no other", () => {
    const fns = (abi: Abi) => abi.filter((i) => i.type === "function").map((i) => (i as { name: string }).name).sort();
    expect(fns(withSquareErrors(squareJobAbi))).toEqual(fns(squareJobAbi));
  });
});
