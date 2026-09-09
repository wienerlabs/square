import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import { simpleAccountAbi } from "../src/abi.js";
import {
  callGasLimitFromTransactionEstimate,
  executionGasOfTransactionEstimate,
  intrinsicCalldataGas,
  CALL_GAS_LIMIT_SAFETY_PERCENT,
  INTRINSIC_CALLDATA_NON_ZERO_BYTE_GAS,
  INTRINSIC_CALLDATA_ZERO_BYTE_GAS,
  INTRINSIC_TRANSACTION_GAS,
} from "../src/callGasLimit.js";

const ENTRY_POINT_UNUSED_GAS_PENALTY_PERCENT = 10n;

function unusedGasPenalty(limit: bigint, executionGasUsed: bigint): bigint {
  if (limit <= executionGasUsed) return 0n;
  return ((limit - executionGasUsed) * ENTRY_POINT_UNUSED_GAS_PENALTY_PERCENT) / 100n;
}

describe("the gas a whole-transaction estimate carries and the callGasLimit taken from it", () => {
  it("prices calldata at 4 gas per zero byte and 16 per non-zero byte", () => {
    expect(INTRINSIC_CALLDATA_ZERO_BYTE_GAS).toBe(4n);
    expect(INTRINSIC_CALLDATA_NON_ZERO_BYTE_GAS).toBe(16n);
    expect(intrinsicCalldataGas("0x")).toBe(0n);
    expect(intrinsicCalldataGas("0x00")).toBe(4n);
    expect(intrinsicCalldataGas("0xff")).toBe(16n);
    expect(intrinsicCalldataGas("0x00ff00")).toBe(24n);
    expect(intrinsicCalldataGas("0xffffffff")).toBe(64n);
  });

  it("subtracts the 21,000 intrinsic and the calldata gas of the estimated call", () => {
    const callData: Hex = "0x00ff00";
    const estimate = INTRINSIC_TRANSACTION_GAS + 24n + 50_000n;
    expect(INTRINSIC_TRANSACTION_GAS).toBe(21_000n);
    expect(executionGasOfTransactionEstimate(estimate, callData)).toBe(50_000n);
    expect(executionGasOfTransactionEstimate(estimate, callData)).toBe(
      estimate - INTRINSIC_TRANSACTION_GAS - intrinsicCalldataGas(callData),
    );
  });

  it("clamps to zero rather than going negative when the estimate is below the intrinsic floor", () => {
    expect(executionGasOfTransactionEstimate(0n, "0x")).toBe(0n);
    expect(executionGasOfTransactionEstimate(INTRINSIC_TRANSACTION_GAS, "0xff")).toBe(0n);
    expect(executionGasOfTransactionEstimate(INTRINSIC_TRANSACTION_GAS, "0x")).toBe(0n);
    expect(callGasLimitFromTransactionEstimate(INTRINSIC_TRANSACTION_GAS, "0xff")).toBe(0n);
  });

  it("applies the named safety multiplier to the execution gas, and nothing else", () => {
    const callData: Hex = "0x00ff00";
    const estimate = INTRINSIC_TRANSACTION_GAS + 24n + 50_000n;
    expect(CALL_GAS_LIMIT_SAFETY_PERCENT).toBe(120n);
    expect(callGasLimitFromTransactionEstimate(estimate, callData)).toBe(60_000n);
    expect(callGasLimitFromTransactionEstimate(estimate, callData, 100n)).toBe(50_000n);
    expect(callGasLimitFromTransactionEstimate(estimate, callData, 150n)).toBe(75_000n);
    expect(callGasLimitFromTransactionEstimate(estimate, callData, 110n)).toBe(55_000n);
  });

  it("leaves a SimpleAccount execute below the raw estimate that the EntryPoint would penalise", () => {
    const callData = encodeFunctionData({
      abi: simpleAccountAbi,
      functionName: "execute",
      args: ["0x8464135c8F25Da09e49BC8782676a84730C318bC", 0n, "0xa9059cbb"],
    });
    const executionGas = 47_000n;
    const estimate = INTRINSIC_TRANSACTION_GAS + intrinsicCalldataGas(callData) + executionGas;
    const limit = callGasLimitFromTransactionEstimate(estimate, callData);

    expect(intrinsicCalldataGas(callData)).toBeGreaterThan(0n);
    expect(executionGasOfTransactionEstimate(estimate, callData)).toBe(executionGas);
    expect(limit).toBe(56_400n);
    expect(limit).toBeLessThan(estimate);
    expect(limit).toBeGreaterThan(executionGas);
    expect(unusedGasPenalty(limit, executionGas)).toBeLessThan(unusedGasPenalty(estimate, executionGas));
  });
});
