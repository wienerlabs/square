import { EndpointError, findA2AEndpoint, wellKnownUrlFor, type AgentCardLike, type WellKnownCache } from "@squaresdk/a2a";
import { a2aEndpointOf } from "@squaresdk/agent";
import { didOfRegistration, parseDid, type DidResolutionResult } from "@squaresdk/did-resolver";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";

/** What the lookup needs of a resolver; `AipDidResolver` is one. */
export interface DidResolverLike {
  resolve(did: string): Promise<DidResolutionResult>;
}

export interface AgentCapability {
  id: string;
  description: string;
  /** Decimal USDC per task. Present only when the card prices it in this chain's USDC. */
  price?: string;
}

/** An agent as the chain and its card describe it, for a caller deciding whether to hire it. */
export interface AgentProfile {
  did: string;
  agentId: string;
  chainId: number;
  registry: string;
  /** Who holds the ERC-8004 token. */
  owner: Address;
  /**
   * The address a job for this agent is created for: the agent wallet when
   * the registry has one set, the owner otherwise. SquareHook accepts a
   * submit that binds the agent from either.
   */
  provider: Address;
  deactivated: boolean;
  name: string;
  description: string;
  a2aEndpoint: string | undefined;
  x402Support: boolean;
  capabilities: AgentCapability[];
  /** What was odd about the agent, for the caller to weigh; never a reason to refuse by itself. */
  warnings: string[];
}

export interface LookupOptions {
  resolver: DidResolverLike;
  cards: WellKnownCache;
  /** The chain this server works on; an agent on another is refused. */
  chainId: number;
  /** The USDC prices must be in. */
  usdc: Address;
}

export class AgentLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLookupError";
  }
}

const DID = /^did:/i;
const HTTP_URL = /^https?:\/\//i;

/**
 * Find an agent by its did:aip, or by its https URL.
 *
 * Identity comes from the chain: the DID resolves to the token's owner and
 * to the services its on-chain registration file names. Everything a caller
 * would hire on, the name, the capabilities, the prices, comes from the card
 * the agent serves at its A2A origin's well-known path, and the card is
 * held to the chain: it must register the DID it was reached through, or
 * the profile carries a warning saying it does not. A URL is the same walk
 * from the other end: its card names the DID, and the DID is resolved.
 */
export async function lookupAgent(reference: string, options: LookupOptions): Promise<AgentProfile> {
  const ref = reference.trim();
  let did: string;
  let urlCard: { card: AgentCardLike; wellKnown: string } | undefined;
  if (DID.test(ref)) {
    did = ref;
  } else if (HTTP_URL.test(ref)) {
    urlCard = await cardAt(ref, options);
    did = didIn(urlCard, options);
  } else {
    throw new AgentLookupError(`${JSON.stringify(ref)} is neither a did:aip nor an https URL`);
  }

  let parsed;
  try {
    parsed = parseDid(did);
  } catch (error) {
    throw new AgentLookupError(`${did} is not a did:aip: ${messageOf(error)}`);
  }
  if (parsed.version !== 2) throw new AgentLookupError(`${did} is a did:aip v1 identifier; only v2 agents are on ERC-8004`);
  if (parsed.chainId !== options.chainId) {
    throw new AgentLookupError(`${did} is on chain ${parsed.chainId}; this server works on chain ${options.chainId}`);
  }

  const resolution = await options.resolver.resolve(did);
  const failure = resolution.didResolutionMetadata.error;
  if (failure !== undefined || resolution.didDocument === null) {
    const detail = resolution.didResolutionMetadata.errorMessage;
    throw new AgentLookupError(`${did} did not resolve: ${failure ?? "no document"}${detail ? ` (${detail})` : ""}`);
  }
  const document = resolution.didDocument;
  const warnings = (resolution.didResolutionMetadata.warnings ?? []).map((w) => w.message);

  const owner = accountOf(document.verificationMethod.find((m) => m.id === `${did}#owner`)?.blockchainAccountId);
  if (owner === undefined) throw new AgentLookupError(`${did} resolved without an owner key`);
  const wallet = accountOf(document.verificationMethod.find((m) => m.id === `${did}#agent-wallet`)?.blockchainAccountId);
  const provider = wallet ?? owner;

  const deactivated = resolution.didDocumentMetadata.deactivated === true;
  if (resolution.didDocumentMetadata.registrationFile === "unavailable") {
    warnings.push("the on-chain registration file could not be read; the document lists no services");
  }

  // The endpoint is the chain's to name. When the chain names none and the
  // caller came in through a URL, the card at that URL is what it was asked
  // about, and its endpoint is used with the warning that says so: the
  // chain still vouches for the owner the job is created for, and the card
  // is held to registering this DID below.
  let a2aEndpoint = endpointIn({ services: document.service.map((s) => ({ name: s.type, endpoint: s.serviceEndpoint })) }, warnings);
  if (a2aEndpoint === undefined && urlCard !== undefined) {
    a2aEndpoint = endpointIn(urlCard.card, warnings);
    if (a2aEndpoint !== undefined) warnings.push(`the chain names no A2A endpoint for ${did}; using the one the card at ${urlCard.wellKnown} advertises`);
  }

  const profile: AgentProfile = {
    did,
    agentId: parsed.agentId.toString(),
    chainId: parsed.chainId,
    registry: parsed.registry,
    owner,
    provider,
    deactivated,
    name: "",
    description: "",
    a2aEndpoint,
    x402Support: false,
    capabilities: [],
    warnings,
  };
  if (a2aEndpoint === undefined) return profile;

  const card = await options.cards.get(a2aEndpoint);
  if (card === null) {
    warnings.push(`no agent card at ${wellKnownUrlFor(a2aEndpoint)}; the agent cannot be hired without one`);
    return profile;
  }
  if (!registeredDids(card).includes(did)) {
    warnings.push(`the card at ${wellKnownUrlFor(a2aEndpoint)} does not register ${did}`);
  }
  readCard(card, profile, options);
  return profile;
}

/** The A2A endpoint a card (or a document read as one) advertises, or undefined with the reason recorded. */
function endpointIn(card: AgentCardLike, warnings: string[]): string | undefined {
  try {
    return findA2AEndpoint(card);
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    warnings.push(error.message);
    return undefined;
  }
}

/** The card an agent URL serves. */
async function cardAt(url: string, options: LookupOptions): Promise<{ card: AgentCardLike; wellKnown: string }> {
  let endpoint: string;
  try {
    endpoint = a2aEndpointOf(url);
  } catch {
    throw new AgentLookupError(`${JSON.stringify(url)} is not a URL`);
  }
  const wellKnown = wellKnownUrlFor(endpoint);
  const card = await options.cards.get(endpoint);
  if (card === null) throw new AgentLookupError(`no agent card at ${wellKnown}`);
  return { card, wellKnown };
}

/** The DID a card registers on this chain. */
function didIn({ card, wellKnown }: { card: AgentCardLike; wellKnown: string }, options: LookupOptions): string {
  const dids = registeredDids(card);
  const here = dids.find((d) => {
    const parsed = parseDid(d);
    return parsed.version === 2 && parsed.chainId === options.chainId;
  });
  if (here === undefined) {
    throw new AgentLookupError(
      dids.length === 0
        ? `the card at ${wellKnown} registers no agent`
        : `the card at ${wellKnown} registers no agent on chain ${options.chainId} (it names ${dids.join(", ")})`,
    );
  }
  return here;
}

function registeredDids(card: AgentCardLike): string[] {
  const registrations = (card as { registrations?: unknown }).registrations;
  if (!Array.isArray(registrations)) return [];
  return registrations.map(didOfRegistration).filter((d): d is string => d !== null);
}

function readCard(card: AgentCardLike, profile: AgentProfile, options: LookupOptions): void {
  const c = card as Record<string, unknown>;
  if (typeof c.name === "string") profile.name = c.name;
  if (typeof c.description === "string") profile.description = c.description;
  profile.x402Support = c.x402Support === true;
  const extension = c["x-aip"];
  const capabilities = typeof extension === "object" && extension !== null ? (extension as { capabilities?: unknown }).capabilities : undefined;
  if (!Array.isArray(capabilities)) {
    profile.warnings.push("the card carries no x-aip capabilities; there is nothing to hire the agent for");
    return;
  }
  for (const raw of capabilities) {
    if (typeof raw !== "object" || raw === null) continue;
    const { id, description, pricing } = raw as { id?: unknown; description?: unknown; pricing?: unknown };
    if (typeof id !== "string" || id === "") continue;
    const capability: AgentCapability = { id, description: typeof description === "string" ? description : "" };
    if (typeof pricing === "object" && pricing !== null) {
      const { amount, token, network } = pricing as { amount?: unknown; token?: unknown; network?: unknown };
      const inUsdc = typeof token === "string" && isAddress(token) && isAddressEqual(token, options.usdc);
      const onChain = network === `eip155:${options.chainId}`;
      if (typeof amount === "string" && inUsdc && onChain) capability.price = amount;
      else profile.warnings.push(`${id} is priced in ${String(token)} on ${String(network)}, not this chain's USDC; treated as unpriced`);
    }
    profile.capabilities.push(capability);
  }
}

/** The address in a CAIP-10 `eip155:<chain>:<address>`. */
function accountOf(caip10: string | undefined): Address | undefined {
  if (caip10 === undefined) return undefined;
  const address = caip10.split(":")[2];
  if (address === undefined) return undefined;
  try {
    return getAddress(address);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
