import { WellKnownCache } from "@squaresdk/a2a";
import { registrationFile, type CardCapability, type RegistrationFile } from "@squaresdk/agent";
import { deploymentFor } from "@squaresdk/core";
import type { DidResolutionResult } from "@squaresdk/did-resolver";
import { getAddress, type Address } from "viem";
import type { DidResolverLike } from "../../src/agents.js";

export const CHAIN_ID = 31337;
export const deployment = deploymentFor(CHAIN_ID);
export const REGISTRY = deployment.identityRegistry.toLowerCase();
export const OWNER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil 1
export const WALLET: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil 2
export const didOf = (agentId: number | bigint, chainId = CHAIN_ID, registry = REGISTRY) => `did:aip:eip155:${chainId}:${registry}:${agentId}`;

export interface ResolutionShape {
  owner?: Address | undefined;
  wallet?: Address | undefined;
  /** `services[]` of the on-chain registration file; omit for a file that could not be read. */
  services?: Array<{ name: string; endpoint: string }> | undefined;
  deactivated?: boolean | undefined;
  warnings?: string[] | undefined;
  error?: DidResolutionResult["didResolutionMetadata"]["error"] | undefined;
}

/** A resolution the way `AipDidResolver` shapes one, from the parts a test cares about. */
export function resolution(did: string, shape: ResolutionShape = {}): DidResolutionResult {
  const chainId = Number(did.split(":")[3]);
  if (shape.error) {
    return { didDocument: null, didResolutionMetadata: { error: shape.error, errorMessage: `${shape.error} for ${did}` }, didDocumentMetadata: {} };
  }
  const owner = shape.owner ?? OWNER;
  const method = (fragment: string, address: Address) => ({
    id: `${did}#${fragment}`,
    type: "EcdsaSecp256k1RecoveryMethod2020" as const,
    controller: did,
    blockchainAccountId: `eip155:${chainId}:${getAddress(address)}`,
  });
  return {
    didDocument: {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      controller: `did:pkh:eip155:${chainId}:${getAddress(owner)}`,
      verificationMethod: [method("owner", owner), ...(shape.wallet ? [method("agent-wallet", shape.wallet)] : [])],
      authentication: [`${did}#owner`],
      capabilityInvocation: [`${did}#owner`],
      assertionMethod: [`${did}#owner`],
      service: (shape.services ?? []).map((s) => ({ id: `${did}#${s.name.toLowerCase()}`, type: s.name, serviceEndpoint: s.endpoint })),
    },
    didResolutionMetadata: {
      contentType: "application/did+ld+json",
      ...(shape.warnings?.length ? { warnings: shape.warnings.map((message) => ({ code: "test", message })) } : {}),
    },
    didDocumentMetadata: {
      versionId: "1",
      ...(shape.deactivated ? { deactivated: true, deactivationReason: "registrationInactive" as const } : {}),
      ...(shape.services === undefined ? { registrationFile: "unavailable" as const } : {}),
    },
  };
}

export function resolverOf(table: Record<string, DidResolutionResult>): DidResolverLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async resolve(did) {
      asked.push(did);
      return table[did] ?? { didDocument: null, didResolutionMetadata: { error: "notFound", errorMessage: `no ${did}` }, didDocumentMetadata: {} };
    },
  };
}

export interface CardShape {
  name?: string;
  url?: string;
  did?: string;
  agentId?: bigint;
  chainId?: number;
  capabilities?: CardCapability[];
  x402Support?: boolean;
  token?: string;
}

/** A card the way `@squaresdk/agent` writes one. */
export function card(shape: CardShape = {}): RegistrationFile {
  const chainId = shape.chainId ?? CHAIN_ID;
  const agentId = shape.agentId ?? 7n;
  return registrationFile({
    name: shape.name ?? "Atlas",
    description: "Summarises what it is given.",
    url: shape.url ?? "https://atlas.example",
    did: shape.did ?? didOf(agentId, chainId),
    agentId,
    agentRegistry: `eip155:${chainId}:${REGISTRY}`,
    token: shape.token ?? deployment.usdc.toLowerCase(),
    network: `eip155:${chainId}`,
    capabilities: shape.capabilities ?? [{ id: "text.summarize", description: "Summarise a document.", price: "0.05" }],
    x402Support: shape.x402Support ?? false,
  });
}

/** A `WellKnownCache` answering from a table of well-known URLs; anything else is a 404. */
export function cardsOf(table: Record<string, unknown>, extra?: (url: string, init?: RequestInit) => Promise<Response> | undefined): WellKnownCache & { fetched: string[] } {
  const fetched: string[] = [];
  const cache = new WellKnownCache({
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetched.push(url);
      const other = extra?.(url, init);
      if (other) return other;
      const body = table[url];
      if (body === undefined) return new Response("not here", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return Object.assign(cache, { fetched });
}
