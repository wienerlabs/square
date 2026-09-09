import { formatDid } from "@squaresdk/did-resolver";
import { describe, expect, it } from "vitest";
import type { PublicClient, TransactionReceipt } from "viem";
import {
  AgentIdMismatchError,
  createSquareClient,
  DeploymentChainMismatchError,
  deploymentFor,
  DidScopeMismatchError,
  encodeSubmitOptParams,
  TransactionRevertedError,
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
}

interface SimulatedCall {
  functionName: string;
  args: readonly unknown[];
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
  const publicClient = {
    chain: fakeChain(options, "publicChainId"),
    simulateContract: async (request: SimulatedCall) => {
      calls.push(request);
      return { request };
    },
    waitForTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: sender },
    chain: fakeChain(options, "walletChainId"),
    writeContract: async () => txHash,
  } as unknown as SquareWalletClient;
  return { calls, publicClient, walletClient };
}

function square(options: FakeOptions = {}) {
  const { calls, publicClient, walletClient } = fakes(options);
  return { calls, client: createSquareClient({ publicClient, walletClient, deployment }) };
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
