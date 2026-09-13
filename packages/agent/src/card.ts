/**
 * The ERC-8004 registration file an agent serves about itself, in the shape
 * docs/agent-card/schema.json fixes: the four ERC-8004 fields, the services
 * a caller dispatches through, the registration that ties the file to the
 * on-chain agent, and the `x-aip` extension carrying the capabilities and
 * their prices. `test/card.test.ts` validates the output against the schema.
 */

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const AIP_EXTENSION_TYPE = "https://github.com/wienerlabs/square/blob/main/docs/agent-card/README.md#v1";

export type AgentType = "LLM" | "Task" | "Execution";

export interface CardCapability {
  id: string;
  description: string;
  /** Decimal USDC, whole units, as a string: "0.05". Absent when the capability is not priced per call. */
  price?: string | undefined;
}

export interface CardOptions {
  name: string;
  description: string;
  /** Where the agent answers, origin only: `https://atlas.example`. */
  url: string;
  did: string;
  agentId: bigint;
  /** `eip155:<chainId>:<identity registry, lowercase>` */
  agentRegistry: string;
  /** Lowercase ERC-20 address the prices are in. */
  token: string;
  /** CAIP-2, `eip155:<chainId>`. */
  network: string;
  capabilities: readonly CardCapability[];
  agentType?: AgentType | undefined;
  slug?: string | undefined;
  agentVersion?: string | undefined;
  image?: string | undefined;
  x402Support?: boolean | undefined;
}

export interface RegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: true;
  registrations: Array<{ agentId: number | string; agentRegistry: string }>;
  supportedTrust: string[];
  "x-aip": {
    type: typeof AIP_EXTENSION_TYPE;
    agentType: AgentType;
    slug?: string;
    agentVersion?: string;
    capabilities: Array<{ id: string; description: string; pricing?: { amount: string; token: string; network: string } }>;
  };
}

const CAPABILITY_ID = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

export function a2aEndpointOf(url: string): string {
  return `${new URL(url).origin}/a2a`;
}

export function registrationFile(options: CardOptions): RegistrationFile {
  if (options.capabilities.length === 0) {
    throw new Error("an agent with no capability has no card: declare one with agent.capability(...) first");
  }
  for (const capability of options.capabilities) {
    if (!CAPABILITY_ID.test(capability.id) || capability.id.length > 64) {
      throw new Error(`capability id ${JSON.stringify(capability.id)} is not dotted lowercase (text.summarize)`);
    }
  }
  const agentId = options.agentId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(options.agentId) : options.agentId.toString();
  return {
    type: REGISTRATION_TYPE,
    name: options.name,
    description: options.description,
    ...(options.image !== undefined ? { image: options.image } : {}),
    services: [
      { name: "A2A", endpoint: a2aEndpointOf(options.url), version: "0.3.0" },
      { name: "DID", endpoint: options.did, version: "v2" },
      { name: "web", endpoint: new URL(options.url).origin + "/" },
    ],
    x402Support: options.x402Support ?? false,
    active: true,
    registrations: [{ agentId, agentRegistry: options.agentRegistry }],
    supportedTrust: ["reputation"],
    "x-aip": {
      type: AIP_EXTENSION_TYPE,
      agentType: options.agentType ?? "Task",
      ...(options.slug !== undefined ? { slug: options.slug } : {}),
      ...(options.agentVersion !== undefined ? { agentVersion: options.agentVersion } : {}),
      capabilities: options.capabilities.map((capability) => ({
        id: capability.id,
        description: capability.description,
        ...(capability.price !== undefined
          ? { pricing: { amount: capability.price, token: options.token, network: options.network } }
          : {}),
      })),
    },
  };
}
