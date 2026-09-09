import { hexToBytes, type Hex } from "viem";

export const INTRINSIC_TRANSACTION_GAS = 21_000n;

export const INTRINSIC_CALLDATA_ZERO_BYTE_GAS = 4n;

export const INTRINSIC_CALLDATA_NON_ZERO_BYTE_GAS = 16n;

export const CALL_GAS_LIMIT_SAFETY_PERCENT = 120n;

export function intrinsicCalldataGas(callData: Hex): bigint {
  let gas = 0n;
  for (const byte of hexToBytes(callData)) {
    gas += byte === 0 ? INTRINSIC_CALLDATA_ZERO_BYTE_GAS : INTRINSIC_CALLDATA_NON_ZERO_BYTE_GAS;
  }
  return gas;
}

export function executionGasOfTransactionEstimate(estimate: bigint, callData: Hex): bigint {
  const intrinsic = INTRINSIC_TRANSACTION_GAS + intrinsicCalldataGas(callData);
  return estimate > intrinsic ? estimate - intrinsic : 0n;
}

export function callGasLimitFromTransactionEstimate(
  estimate: bigint,
  callData: Hex,
  safetyPercent: bigint = CALL_GAS_LIMIT_SAFETY_PERCENT,
): bigint {
  return (executionGasOfTransactionEstimate(estimate, callData) * safetyPercent) / 100n;
}
