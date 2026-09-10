import type { ParsedDid } from "./types.js";

/** Thrown only inside parse; resolve() converts it to metadata and never rethrows. */
export class InvalidDidError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid did:aip — ${reason}`);
    this.name = "InvalidDidError";
  }
}

const LOWER_HEX_40 = /^0x[0-9a-f]{40}$/;
const DECIMAL_NO_LEADING_ZERO = /^(0|[1-9][0-9]*)$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SLUG = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Parse a did:aip identifier.
 *
 * Version is decided by segment count and nothing else: v1 has two, v2 has four.
 * The counts cannot collide — a v1 owner segment is base58 over 32 bytes, so
 * 32–44 characters, and v2's first segment is the fixed token `eip155`. Matching
 * on the first segment instead would be the fragile version of the same test,
 * and it is what the spec (§9.1) tells implementations not to do.
 */
export function parseDid(did: string): ParsedDid {
  if (typeof did !== "string") throw new InvalidDidError("not a string");
  if (!did.startsWith("did:aip:")) throw new InvalidDidError("not a did:aip identifier");

  const rest = did.slice("did:aip:".length);
  if (rest.length === 0) throw new InvalidDidError("empty method-specific identifier");

  const seg = rest.split(":");
  if (seg.length === 2) return parseV1(did, seg as [string, string]);
  if (seg.length === 4) return parseV2(did, seg as [string, string, string, string]);
  throw new InvalidDidError(
    `expected 2 segments (v1) or 4 (v2), got ${seg.length}`
  );
}

function parseV1(did: string, [ownerPubkey, agentId]: [string, string]): ParsedDid {
  if (!BASE58.test(ownerPubkey) || ownerPubkey.length < 32 || ownerPubkey.length > 44) {
    throw new InvalidDidError("v1 owner segment is not a base58 Ed25519 public key");
  }
  if (!SLUG.test(agentId)) throw new InvalidDidError("v1 agent-id is not a valid slug");
  return { version: 1, did, ownerPubkey, agentId };
}

function parseV2(
  did: string,
  [namespace, chainId, registry, agentId]: [string, string, string, string]
): ParsedDid {
  if (namespace !== "eip155") {
    throw new InvalidDidError(`namespace must be "eip155", got "${namespace}"`);
  }
  if (!DECIMAL_NO_LEADING_ZERO.test(chainId) || chainId === "0") {
    throw new InvalidDidError("chain-id must be a positive decimal without leading zeros");
  }
  // Number() rounds above 2^53, so two different chain-id strings would parse
  // to the same value and two unequal DIDs would name the same agent, which
  // is the very thing the registry check below refuses to allow (spec §3.2).
  // agent-id is a bigint and does not have this problem.
  if (!Number.isSafeInteger(Number(chainId))) {
    throw new InvalidDidError("chain-id must not exceed 2^53 - 1");
  }
  if (!LOWER_HEX_40.test(registry)) {
    // Deliberately not normalised. DID Core equality is string equality, so
    // accepting a checksummed address here would let two unequal DIDs resolve
    // to the same agent (spec §3.2).
    throw new InvalidDidError(
      /^0x[0-9a-fA-F]{40}$/.test(registry)
        ? "registry must be lowercase in the DID string"
        : "registry must be 0x followed by 40 hex digits"
    );
  }
  if (!DECIMAL_NO_LEADING_ZERO.test(agentId)) {
    throw new InvalidDidError("agent-id must be a decimal without leading zeros");
  }
  return {
    version: 2,
    did,
    namespace: "eip155",
    chainId: Number(chainId),
    registry: registry as `0x${string}`,
    agentId: BigInt(agentId),
    agentRegistry: `${namespace}:${chainId}:${registry}`,
  };
}

/** Build a v2 DID from its parts. Inverse of parseDid; the mapping is total. */
export function formatDid(chainId: number, registry: string, agentId: bigint | number): string {
  return `did:aip:eip155:${chainId}:${registry.toLowerCase()}:${agentId.toString()}`;
}
