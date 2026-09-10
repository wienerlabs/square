import { TransactionRevertedError } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { BaseError, type TransactionReceipt } from "viem";
import { truncate } from "./format";
import { describeError, switchNetworkGuidance } from "./tx";

const hash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;

function revertedReceipt(): TransactionReceipt {
  return { status: "reverted", transactionHash: hash, blockNumber: 12n, gasUsed: 21_000n, logs: [] } as unknown as TransactionReceipt;
}

describe("describeError", () => {
  it("names a mined transaction that reverted and points at it", () => {
    expect(describeError(new TransactionRevertedError(hash, revertedReceipt()))).toBe(
      "Reverted on chain: transaction 0x1c8aff95…6deac8 was mined and applied nothing.",
    );
  });

  it("still reports a viem error by its short message", () => {
    expect(describeError(new BaseError("the wallet rejected the request"))).toContain("the wallet rejected the request");
  });

  it("falls back to the message of a plain error", () => {
    expect(describeError(new Error("no funds"))).toBe("no funds");
  });
});

describe("switchNetworkGuidance", () => {
  it("leads with the next step, so the toast still carries it after truncation", () => {
    const notice = switchNetworkGuidance("Arc Testnet", new Error("user rejected the request"));
    expect(notice.startsWith("Switch to Arc Testnet inside the wallet")).toBe(true);
    expect(truncate(notice, 200)).toContain("disconnect");
    expect(notice).toContain("user rejected the request");
  });
});
