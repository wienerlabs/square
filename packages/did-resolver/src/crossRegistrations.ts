import { parseDid } from "./parse.js";

/**
 * A Registration File's `registrations[]` (spec §8), as the did:aip v2 DIDs
 * they name.
 *
 * Each entry maps to a DID by §3.2, and the mapping goes through the same
 * parser a DID string goes through, so an entry is accepted exactly when the
 * DID it names would be: `eip155:<chainId>:<registry>` with a positive decimal
 * chain id, a 40-hex registry (case is normalised, the way `formatDid` does,
 * because the file carries ERC-8004 strings and the identifier is lowercase),
 * and an agentId that is a non-negative integer, as a number or a decimal
 * string. Anything else is counted, not read: the file is owner-controlled
 * input and an entry that names nothing must not take the rest down.
 *
 * An entry naming `self` is dropped. It carries nothing, and a round trip
 * from an agent to itself would verify trivially.
 */
export function claimedCrossRegistrations(
  registrations: unknown,
  self: string
): { dids: string[]; malformed: number } {
  if (!Array.isArray(registrations)) return { dids: [], malformed: 0 };
  const dids: string[] = [];
  let malformed = 0;
  for (const entry of registrations) {
    const did = didOfRegistration(entry);
    if (did === null) {
      malformed += 1;
      continue;
    }
    if (did === self || dids.includes(did)) continue;
    dids.push(did);
  }
  return { dids, malformed };
}

/** `{ agentId, agentRegistry }` → the DID it names, or null when it names none. */
export function didOfRegistration(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { agentId, agentRegistry } = entry as { agentId?: unknown; agentRegistry?: unknown };
  if (typeof agentRegistry !== "string") return null;
  const parts = agentRegistry.split(":");
  if (parts.length !== 3 || parts[0] !== "eip155") return null;
  let id: string;
  if (typeof agentId === "number") {
    if (!Number.isSafeInteger(agentId) || agentId < 0) return null;
    id = String(agentId);
  } else if (typeof agentId === "string") {
    id = agentId;
  } else {
    return null;
  }
  const did = `did:aip:eip155:${parts[1]}:${parts[2]!.toLowerCase()}:${id}`;
  try {
    return parseDid(did).version === 2 ? did : null;
  } catch {
    return null;
  }
}
