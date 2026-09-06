import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, toHex, type Hex } from "viem";

export const Outcome = {
  None: 0,
  Complete: 1,
  Reject: 2,
  Lapsed: 3,
} as const;

export type OutcomeValue = (typeof Outcome)[keyof typeof Outcome];

const finalizeParams = parseAbiParameters("string tag, uint256 jobId, bytes32 deliverable");
const resolutionParams = parseAbiParameters("string tag, uint256 jobId, uint8 outcome, uint16 providerBps");

export function finalizeReason(jobId: bigint, deliverable: Hex): Hex {
  return keccak256(encodeAbiParameters(finalizeParams, ["square.finalize.v1", jobId, deliverable]));
}

export function resolutionHash(jobId: bigint, outcome: OutcomeValue, providerBps: number): Hex {
  return keccak256(encodeAbiParameters(resolutionParams, ["square.resolution.v1", jobId, outcome, providerBps]));
}

export function hashDeliverable(content: string | Uint8Array): Hex {
  return keccak256(typeof content === "string" ? stringToHex(content) : toHex(content));
}
