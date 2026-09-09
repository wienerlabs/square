import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";

export const FULL_BPS = 10_000;
export const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

const submitParams = parseAbiParameters("uint256 agentId, bytes32 validationRequestHash");
const completeParams = parseAbiParameters("uint16 providerBps, bytes complianceProof");

export interface SubmitOptParams {
  agentId: bigint;
  validationRequestHash?: Hex;
}

export interface CompleteOptParams {
  providerBps?: number;
  complianceProof?: Hex;
}

export function encodeSubmitOptParams(params: SubmitOptParams): Hex {
  return encodeAbiParameters(submitParams, [params.agentId, params.validationRequestHash ?? ZERO_HASH]);
}

export function decodeSubmitOptParams(data: Hex): { agentId: bigint; validationRequestHash: Hex } | null {
  if (data === "0x") return null;
  const [agentId, validationRequestHash] = decodeAbiParameters(submitParams, data);
  return { agentId, validationRequestHash };
}

export function encodeCompleteOptParams(params: CompleteOptParams = {}): Hex {
  const providerBps = params.providerBps ?? FULL_BPS;
  if (!Number.isInteger(providerBps) || providerBps < 0 || providerBps > FULL_BPS) {
    throw new RangeError(`providerBps must be an integer between 0 and ${FULL_BPS}`);
  }
  return encodeAbiParameters(completeParams, [providerBps, params.complianceProof ?? "0x"]);
}

export function decodeCompleteOptParams(data: Hex): { providerBps: number; complianceProof: Hex } {
  if (data === "0x") return { providerBps: FULL_BPS, complianceProof: "0x" };
  const [providerBps, complianceProof] = decodeAbiParameters(completeParams, data);
  return { providerBps, complianceProof };
}
