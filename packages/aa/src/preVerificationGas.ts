import { encodeAbiParameters, hexToBytes, type Hex } from "viem";
import type { PackedUserOperation } from "viem/account-abstraction";

export type PreVerificationGasOverheads = {
  fixed: bigint;
  perUserOp: bigint;
  perUserOpWord: bigint;
  zeroByte: bigint;
  nonZeroByte: bigint;
  bundleSize: bigint;
};

export const DEFAULT_PRE_VERIFICATION_GAS_OVERHEADS: PreVerificationGasOverheads = {
  fixed: 21_000n,
  perUserOp: 18_300n,
  perUserOpWord: 4n,
  zeroByte: 4n,
  nonZeroByte: 16n,
  bundleSize: 1n,
};

const packedUserOperationParameters = [
  {
    type: "tuple",
    components: [
      { name: "sender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "initCode", type: "bytes" },
      { name: "callData", type: "bytes" },
      { name: "accountGasLimits", type: "bytes32" },
      { name: "preVerificationGas", type: "uint256" },
      { name: "gasFees", type: "bytes32" },
      { name: "paymasterAndData", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export function encodePackedUserOperation(userOperation: PackedUserOperation): Hex {
  return encodeAbiParameters(packedUserOperationParameters, [userOperation]);
}

export function calcPreVerificationGas(
  userOperation: PackedUserOperation,
  overheads: PreVerificationGasOverheads = DEFAULT_PRE_VERIFICATION_GAS_OVERHEADS,
): bigint {
  const bytes = hexToBytes(encodePackedUserOperation(userOperation));
  let callDataCost = 0n;
  for (const byte of bytes) callDataCost += byte === 0 ? overheads.zeroByte : overheads.nonZeroByte;
  const words = BigInt(Math.ceil(bytes.length / 32));
  return (
    callDataCost +
    overheads.fixed / overheads.bundleSize +
    overheads.perUserOp +
    overheads.perUserOpWord * words
  );
}
