import type { McpServerConfig } from "@squaresdk/mcp";
import { z } from "zod";
import { SEALED_PREFIX } from "./sealed.js";

/** The model that runs a capability, and whose key pays for it. */
export type ProviderConfig =
  /** The platform's key: `ANTHROPIC_API_KEY` in the host's environment, or the client the host passes in. */
  | { tier: "platform"; model?: string | undefined }
  /** The institution's own key, sealed at rest (`seal`); the host opens it with its seal secret. */
  | { tier: "own"; apiKey: string; model?: string | undefined };

export interface HostedCapability {
  /** Dotted lowercase, the card's alphabet: `research.brief`. */
  id: string;
  description: string;
  /** Decimal USDC per task; absent means any funded amount is accepted. */
  price?: string | undefined;
  /** What the model is told to do. The task's input is the user turn. */
  instructions: string;
  /** May the model call the configured MCP tools. Default true when any are configured. */
  tools?: boolean | undefined;
  /** May the model hire other agents for this capability. Default false. Needs `delegation`. */
  delegate?: boolean | undefined;
}

export interface DelegationConfig {
  /** The agents this one may hire: did:aip identifiers or https URLs. Nothing outside the list is hired, whatever the model asks. */
  allow: string[];
  /** The most one delegated job may be funded with, decimal USDC. A slice of the policy's allowance, never a ceiling of its own. */
  maxPerJob?: string | undefined;
}

export interface HostedAgentConfig {
  name: string;
  description: string;
  /** The ERC-8004 id the host's wallet owns, decimal. */
  agentId: string;
  /** Public origin, for the card. */
  url: string;
  provider: ProviderConfig;
  capabilities: HostedCapability[];
  /** MCP servers the model may call tools on. */
  tools?: McpServerConfig[] | undefined;
  delegation?: DelegationConfig | undefined;
  /** Most model turns per task. Default 12. */
  maxTurns?: number | undefined;
}

const CAPABILITY_ID = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
const USDC = /^\d+(\.\d{1,6})?$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const schema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().regex(/^\d+$/, "a decimal ERC-8004 id"),
  url: z.string().url(),
  provider: z.discriminatedUnion("tier", [
    z.object({ tier: z.literal("platform"), model: z.string().min(1).optional() }),
    z.object({
      tier: z.literal("own"),
      apiKey: z.string().startsWith(SEALED_PREFIX, `an own key is stored sealed (${SEALED_PREFIX}…); seal it with square-hosted seal`),
      model: z.string().min(1).optional(),
    }),
  ]),
  capabilities: z
    .array(
      z.object({
        id: z.string().regex(CAPABILITY_ID, "dotted lowercase, like research.brief").max(64),
        description: z.string().min(1),
        price: z.string().regex(USDC, "decimal USDC, like 0.50").optional(),
        instructions: z.string().min(1),
        tools: z.boolean().optional(),
        delegate: z.boolean().optional(),
      }),
    )
    .min(1, "an agent with no capability has no card"),
  tools: z
    .array(
      z.object({
        name: z.string().regex(SERVER_NAME).refine((n) => !n.includes("__"), 'no "__" in a server name'),
        url: z.string().url(),
        headers: z.record(z.string()).optional(),
      }),
    )
    .optional(),
  delegation: z
    .object({
      allow: z.array(z.string().min(1)).min(1, "list the agents this one may hire"),
      maxPerJob: z.string().regex(USDC).optional(),
    })
    .optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
});

export class HostedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedConfigError";
  }
}

/**
 * A configuration as the platform is handed it, checked. Beyond the shape:
 * capability ids are unique, a capability that delegates needs a
 * `delegation` block, and a sealed key is a sealed key.
 */
export function parseHostedConfig(json: unknown): HostedAgentConfig {
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new HostedConfigError(`${issue.path.join(".") || "config"}: ${issue.message}`);
  }
  const config = result.data;
  const ids = new Set<string>();
  for (const capability of config.capabilities) {
    if (ids.has(capability.id)) throw new HostedConfigError(`capabilities: ${capability.id} is declared twice`);
    ids.add(capability.id);
    if (capability.delegate && config.delegation === undefined) {
      throw new HostedConfigError(`capabilities.${capability.id}: delegates, but the config has no delegation block`);
    }
  }
  return config as HostedAgentConfig;
}
