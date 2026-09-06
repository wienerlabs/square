import { parseDid } from "@squaresdk/did-resolver";
import { getAddress, type Address } from "viem";

export interface AgentReference {
  chainId: number;
  registry: Address;
  agentId: bigint;
}

export class UnsupportedDidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDidError";
  }
}

export function agentFromDid(did: string): AgentReference {
  const parsed = parseDid(did);
  if (parsed.version !== 2) {
    throw new UnsupportedDidError("only did:aip v2 identifiers resolve to an ERC-8004 agent id");
  }
  return { chainId: parsed.chainId, registry: getAddress(parsed.registry), agentId: parsed.agentId };
}
