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
  /**
   * The screener service (services/screener) asked to screen a party of a
   * delegated job that the hook would refuse, before funding and before
   * release (square#368, #369). On a hook that screens, without it a
   * delegation whose party has no fresh record stops before funding.
   */
  screenerUrl?: string | undefined;
}

/**
 * The institution's side of the compliance gate for the jobs this agent
 * delegates (square#335): the policy the wallet committed on chain, as a
 * file beside the config. The proof is made in the host's own process from
 * the circuit's files (`SQUARE_PROVER_ARTIFACTS`), so the policy's secret
 * never leaves it (square#347). With it the host keeps a proof bound to every
 * delegated job and releases each when its window closes; on a stack whose
 * hook holds a module, without it every delegated release would pay this
 * wallet back.
 */
export interface ComplianceConfig {
  /** The policy file (`square policy init` writes one), relative to the config file. Holds the policy's secret. */
  policyFile: string;
  /** How often the bound proofs are checked, ms; well inside the module's tolerance. Default 15000. */
  intervalMs?: number | undefined;
  /**
   * Where the duty keeps the delegated jobs across restarts, relative to the
   * config file (square#348): a window outlives the process. Default
   * `<config file>.duty.json`; `false` keeps none, and the chain is still
   * scanned for this wallet's open jobs at start.
   */
  stateFile?: string | false | undefined;
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
  compliance?: ComplianceConfig | undefined;
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
      screenerUrl: z.string().url().optional(),
    })
    .optional(),
  compliance: z
    .object({
      policyFile: z.string().min(1),
      intervalMs: z.number().int().min(1000).optional(),
      stateFile: z.union([z.string().min(1), z.literal(false)]).optional(),
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
  if (config.compliance && config.delegation === undefined) {
    throw new HostedConfigError("compliance: names a policy, but the config delegates nothing; only delegated jobs are this wallet's to prove");
  }
  return config as HostedAgentConfig;
}
