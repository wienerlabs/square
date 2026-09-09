import { describe, expect, it } from "vitest";
import type { PublicClient, TransactionReceipt } from "viem";
import { createSquareClient, deploymentFor, TransactionRevertedError, type SquareWalletClient } from "../src/index.js";

const deployment = deploymentFor(31337);
const sender = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;

interface FakeOptions {
  status?: "success" | "reverted";
}

interface SimulatedCall {
  functionName: string;
  args: readonly unknown[];
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
    chain: { id: deployment.chainId },
    simulateContract: async (request: SimulatedCall) => {
      calls.push(request);
      return { request };
    },
    waitForTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: sender },
    chain: { id: deployment.chainId },
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
