/** Errors a resolver may report. DID Resolution defines the first three. */
export type ResolutionErrorCode =
  | "invalidDid"
  | "notFound"
  | "representationNotSupported"
  /** Well-formed but this resolver does not speak that version (spec §9.2). */
  | "unsupportedVersion"
  /** No RPC endpoint is configured for the DID's chain id. */
  | "unsupportedChain"
  /** The chain could not be read at all. */
  | "networkError";

export interface ParsedV2 {
  version: 2;
  did: string;
  namespace: "eip155";
  chainId: number;
  registry: `0x${string}`;
  agentId: bigint;
  /** ERC-8004's own identifier: `{namespace}:{chainId}:{registry}`. */
  agentRegistry: string;
}

export interface ParsedV1 {
  version: 1;
  did: string;
  /** base58 Ed25519 owner pubkey */
  ownerPubkey: string;
  /** owner-scoped slug */
  agentId: string;
}

export type ParsedDid = ParsedV1 | ParsedV2;

export interface VerificationMethod {
  id: string;
  type: "EcdsaSecp256k1RecoveryMethod2020";
  controller: string;
  /** CAIP-10, with the address in EIP-55 checksummed form. */
  blockchainAccountId: string;
}

export interface ServiceEntry {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidDocument {
  "@context": string[];
  id: string;
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  capabilityInvocation: string[];
  assertionMethod: string[];
  service: ServiceEntry[];
}

export interface ResolutionWarning {
  code: string;
  message: string;
}

export interface DidResolutionMetadata {
  contentType?: "application/did+ld+json";
  error?: ResolutionErrorCode;
  errorMessage?: string;
  warnings?: ResolutionWarning[];
}

export interface DidDocumentMetadata {
  /** Block number the state was read at. A number, not a timestamp — see spec §6.1. */
  versionId?: string;
  deactivated?: boolean;
  /** How deactivation was determined; the two are not equivalent (spec §7). */
  deactivationReason?: "burned" | "registrationInactive";
  agentRegistry?: string;
  /** Set on a v1 DID resolved through an injected v1 resolver. */
  deprecated?: boolean;
}

export interface DidResolutionResult {
  didDocument: DidDocument | null;
  didResolutionMetadata: DidResolutionMetadata;
  didDocumentMetadata: DidDocumentMetadata;
}

/**
 * Resolves the legacy Solana form.
 *
 * v1 support is injected rather than built in. The point of this package is to
 * read ERC-8004 with viem and nothing else; bundling a Solana client to serve
 * identifiers we are migrating away from would defeat that. A caller that still
 * needs v1 supplies one, and the spec's requirement is met either way: a v1 DID
 * is recognised, never reported as malformed, and without a handler it returns
 * `unsupportedVersion` so the caller can try another resolver.
 */
export type V1Resolver = (parsed: ParsedV1) => Promise<DidResolutionResult>;

export interface ResolverOptions {
  /** chainId → RPC endpoint. */
  rpc: Record<number, string>;
  /** Registry addresses this resolver will read. Omit to allow any. See spec §10.1. */
  allowedRegistries?: string[];
  v1Resolver?: V1Resolver;
  /** Dereferences an agentURI. Defaults to https:// and ipfs:// via a gateway. */
  fetchAgentUri?: (uri: string) => Promise<unknown>;
  ipfsGateway?: string;
  timeoutMs?: number;
}
