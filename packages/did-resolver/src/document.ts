import { getAddress, isAddress } from "viem";
import type { DidDocument, ParsedV2, ServiceEntry, VerificationMethod } from "./types.js";

const DID_CONTEXT = "https://www.w3.org/ns/did/v1";
const SECP256K1_CONTEXT = "https://w3id.org/security/suites/secp256k1recovery-2020/v2";
const ZERO = "0x0000000000000000000000000000000000000000";

/** A `services[]` entry as it appears in an ERC-8004 registration file. */
export interface RegistrationService {
  name?: unknown;
  endpoint?: unknown;
}

export interface RegistrationFile {
  services?: unknown;
  active?: unknown;
}

function verificationMethod(
  did: string,
  fragment: string,
  chainId: number,
  address: string
): VerificationMethod {
  return {
    id: `${did}#${fragment}`,
    type: "EcdsaSecp256k1RecoveryMethod2020",
    controller: did,
    // CAIP-10 wants the checksummed form. This is deliberately the opposite of
    // the DID string, which must stay lowercase — identifier versus value.
    blockchainAccountId: `eip155:${chainId}:${getAddress(address)}`,
  };
}

/** `name` → a fragment-safe slug, per spec §4.5. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "") || "service";
}

/**
 * Turn the registration file's `services[]` into DID Document service entries.
 *
 * Entries that are not objects, or lack a usable name or endpoint, are dropped
 * rather than failing the resolution: the file is owner-controlled input and a
 * malformed entry in it must not take the identity down with it.
 *
 * A `DID` entry pointing at the DID being resolved is a self-reference. It is
 * omitted — it carries nothing, and a consumer that follows service endpoints
 * would loop on it.
 */
export function buildServices(did: string, file: RegistrationFile | null): ServiceEntry[] {
  if (!file || !Array.isArray(file.services)) return [];

  const out: ServiceEntry[] = [];
  const used = new Map<string, number>();

  for (const raw of file.services) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as RegistrationService;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const endpoint = typeof entry.endpoint === "string" ? entry.endpoint.trim() : "";
    if (!name || !endpoint) continue;
    if (name.toUpperCase() === "DID" && endpoint === did) continue;

    const base = slugify(name);
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    out.push({
      id: `${did}#${seen === 1 ? base : `${base}-${seen}`}`,
      type: name,
      serviceEndpoint: endpoint,
    });
  }
  return out;
}

export function buildDidDocument(params: {
  parsed: ParsedV2;
  owner: string;
  agentWallet?: string | undefined;
  registration: RegistrationFile | null;
}): DidDocument {
  const { parsed, owner, agentWallet, registration } = params;
  const did = parsed.did;

  const methods: VerificationMethod[] = [
    verificationMethod(did, "owner", parsed.chainId, owner),
  ];

  // §4.4 keys on the address being non-zero, not on it differing from the owner.
  // ERC-8004 defaults agentWallet to the owner until setAgentWallet is called, so
  // equal-to-owner is the common case and still a distinct role.
  const hasWallet =
    typeof agentWallet === "string" && isAddress(agentWallet) && agentWallet !== ZERO;
  if (hasWallet) {
    methods.push(verificationMethod(did, "agent-wallet", parsed.chainId, agentWallet));
  }

  const ownerRef = `${did}#owner`;
  return {
    "@context": [DID_CONTEXT, SECP256K1_CONTEXT],
    id: did,
    controller: `did:pkh:eip155:${parsed.chainId}:${getAddress(owner)}`,
    verificationMethod: methods,
    authentication: [ownerRef],
    capabilityInvocation: [ownerRef],
    assertionMethod: hasWallet ? [ownerRef, `${did}#agent-wallet`] : [ownerRef],
    service: buildServices(did, registration),
  };
}
