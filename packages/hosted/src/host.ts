import Anthropic from "@anthropic-ai/sdk";
import { A2AClient, WellKnownCache } from "@squaresdk/a2a";
import { createAgent, type Agent, type CapabilityCall, type CapabilityOptions, type X402Options } from "@squaresdk/agent";
import type { SquareDeployment, SquareWalletClient } from "@squaresdk/core";
import { AipDidResolver } from "@squaresdk/did-resolver";
import { ToolPool, toolsForAnthropic, type DidResolverLike, type McpTool } from "@squaresdk/mcp";
import { parseUnits, type PublicClient } from "viem";
import { PolicyAllowance } from "./allowance.js";
import type { HostedAgentConfig } from "./config.js";
import { DELEGATE_TOOL, delegate, delegateTool, type DelegationDeps, type DelegationInput } from "./delegation.js";
import { DEFAULT_MODEL, runCapability, type ModelClient, type RunOutcome } from "./model.js";
import { deriveSealKey, open } from "./sealed.js";

export interface HostDeps {
  /** The wallet that owns the config's `agentId`: the provider of every task, and the client of every delegated job. */
  walletClient: SquareWalletClient;
  publicClient: PublicClient;
  deployment?: SquareDeployment | undefined;
  /** The chain's endpoint, for resolving the agents this one delegates to. Needed unless `resolver` is given. */
  rpcUrl?: string | undefined;
  resolver?: DidResolverLike | undefined;
  /**
   * The Anthropic client for the platform tier, or a factory the host
   * builds one from for either tier (`apiKey` is undefined for the platform
   * tier, whose key is the environment's). Default: `new Anthropic()` for
   * the platform, `new Anthropic({ apiKey })` for an own key.
   */
  anthropic?: ModelClient | ((apiKey: string | undefined) => ModelClient) | undefined;
  /** The secret an own-tier key was sealed under. */
  sealSecret?: string | undefined;
  a2a?: A2AClient | undefined;
  cards?: WellKnownCache | undefined;
  x402?: X402Options | undefined;
  /** Delegation: fetch the content behind a delivered reference. See `DelegationDeps`. */
  resolveDeliverable?: DelegationDeps["resolveDeliverable"];
  taskTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  jobDays?: number | undefined;
  maxConcurrent?: number | undefined;
  handlerTimeoutMs?: number | undefined;
  /** Where a run's outcome is reported, per task. */
  onRun?: ((event: { taskId: string; capability: string; outcome: RunOutcome }) => void) | undefined;
}

export interface HostedAgent {
  readonly config: HostedAgentConfig;
  /** The `@squaresdk/agent` agent: `listen`, `card`, `app`, `client`. */
  readonly agent: Agent;
  readonly tools: ToolPool | undefined;
  /** The delegation allowance, when the config delegates. */
  readonly allowance: PolicyAllowance | undefined;
  readonly model: ModelClient;
  close(): Promise<void>;
}

/**
 * The institution's agent, run by the platform from its configuration.
 *
 * Every capability in the config becomes a capability of a
 * `@squaresdk/agent` agent whose handler is a model run: the capability's
 * instructions, the task's input, the MCP tools the config names, and,
 * for a capability that delegates, the `delegate` tool. What the model
 * answers is what the agent delivers, and the agent's settlement puts its
 * hash on chain the way it does for any handler; what the agent earns is
 * the escrow its client funded, and what it spends on delegation comes
 * from its own wallet under the policy that wallet committed on chain.
 *
 * The model's key is the platform's or the institution's own, sealed at
 * rest and opened here; nothing about which one is in use reaches the
 * card or the wire.
 */
export async function hostAgent(config: HostedAgentConfig, deps: HostDeps): Promise<HostedAgent> {
  const model = modelClientFor(config, deps);
  const modelName = config.provider.model ?? DEFAULT_MODEL;
  const agent = createAgent({
    name: config.name,
    description: config.description,
    walletClient: deps.walletClient,
    publicClient: deps.publicClient,
    deployment: deps.deployment,
    agentId: BigInt(config.agentId),
    url: config.url,
    x402: deps.x402,
    maxConcurrent: deps.maxConcurrent,
    handlerTimeoutMs: deps.handlerTimeoutMs,
  });

  const tools = config.tools && config.tools.length > 0 ? new ToolPool({ servers: config.tools }) : undefined;
  // Discovered before the agent listens, so a server that is down says so
  // in the pool's status at start; every run reads the pool again.
  if (tools) await tools.tools();

  let allowance: PolicyAllowance | undefined;
  let delegation: DelegationDeps | undefined;
  if (config.delegation) {
    allowance = new PolicyAllowance({
      client: agent.client,
      maxPerJob: config.delegation.maxPerJob !== undefined ? parseUnits(config.delegation.maxPerJob, 6) : undefined,
    });
    const resolver = deps.resolver ?? resolverFor(deps, agent);
    delegation = {
      client: agent.client,
      a2a: deps.a2a ?? new A2AClient(),
      resolver,
      cards: deps.cards ?? new WellKnownCache(),
      allowance,
      allow: config.delegation.allow,
      callerDid: agent.did,
      taskTimeoutMs: deps.taskTimeoutMs,
      pollIntervalMs: deps.pollIntervalMs,
      jobDays: deps.jobDays,
      resolveDeliverable: deps.resolveDeliverable,
    };
  }

  const handlers = hostedHandlers(config, { model, modelName, tools, delegation, onRun: deps.onRun });
  for (const [id, options] of handlers) agent.capability(id, options);

  return {
    config,
    agent,
    tools,
    allowance,
    model,
    close: async () => {
      await tools?.close();
    },
  };
}

export interface HandlerContext {
  model: ModelClient;
  modelName: string;
  tools?: ToolPool | undefined;
  delegation?: DelegationDeps | undefined;
  onRun?: HostDeps["onRun"];
}

/**
 * The capabilities of the config as `@squaresdk/agent` capabilities, each
 * handled by a model run. Separate from `hostAgent` so the runs can be
 * driven without a chain: the handler is what a task reaches once the
 * agent's settlement has admitted it.
 */
export function hostedHandlers(config: HostedAgentConfig, context: HandlerContext): Map<string, CapabilityOptions> {
  const { tools, delegation } = context;

  // Delegations run one at a time across the agent: two hires signed from
  // one wallet in the same instant can take the same nonce, and the
  // allowance is asked and told around each hire, which two at once would
  // interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const handlers = new Map<string, CapabilityOptions>();
  for (const capability of config.capabilities) {
    const mayUseTools = tools !== undefined && capability.tools !== false;
    const mayDelegate = capability.delegate === true && delegation !== undefined;
    handlers.set(capability.id, {
      description: capability.description,
      price: capability.price,
      handler: async (call: CapabilityCall) => {
        const discovered: McpTool[] = mayUseTools && tools ? await tools.tools() : [];
        const toolDefinitions = [
          ...(mayUseTools ? toolsForAnthropic(discovered) : []),
          ...(mayDelegate && delegation ? [delegateTool(delegation.allow)] : []),
        ];
        const outcome = await runCapability({
          client: context.model,
          model: context.modelName,
          instructions: capability.instructions,
          capability: capability.id,
          input: call.input,
          tools: toolDefinitions,
          maxTurns: config.maxTurns,
          signal: call.signal,
          execute: async (name, input) => {
            if (name === DELEGATE_TOOL) {
              if (!mayDelegate || !delegation) return { content: "this capability may not delegate", isError: true };
              const delegated = await serially(() => delegate(delegation, input as unknown as DelegationInput));
              return { content: delegated.content, isError: delegated.isError };
            }
            if (!mayUseTools || !tools) return { content: `no tool named ${name}`, isError: true };
            const result = await tools.call(name, input, { signal: call.signal });
            return { content: result.text, isError: !result.ok };
          },
        });
        context.onRun?.({ taskId: call.taskId, capability: capability.id, outcome });
        return outcome.text;
      },
    });
  }
  return handlers;
}

function modelClientFor(config: HostedAgentConfig, deps: HostDeps): ModelClient {
  const provider = config.provider;
  let apiKey: string | undefined;
  if (provider.tier === "own") {
    if (deps.sealSecret === undefined) throw new Error(`${config.name} brings its own key, and the host has no seal secret to open it with`);
    apiKey = open(provider.apiKey, deriveSealKey(deps.sealSecret), sealContext(config));
  }
  if (typeof deps.anthropic === "function") return deps.anthropic(apiKey);
  if (deps.anthropic !== undefined) {
    if (provider.tier === "own") throw new Error(`${config.name} brings its own key; pass a factory as anthropic, not a client`);
    return deps.anthropic;
  }
  return apiKey === undefined ? new Anthropic() : new Anthropic({ apiKey });
}

/** What an own key is sealed for: this agent, and no other configuration. */
export function sealContext(config: Pick<HostedAgentConfig, "agentId">): string {
  return `hosted-agent:${config.agentId}`;
}

function resolverFor(deps: HostDeps, agent: Agent): DidResolverLike {
  if (deps.rpcUrl === undefined) throw new Error("delegation resolves the agents it hires; pass rpcUrl or a resolver");
  const deployment = agent.client.deployment;
  return new AipDidResolver({
    rpc: { [deployment.chainId]: deps.rpcUrl },
    allowedRegistries: [deployment.identityRegistry],
    onNetworkError: (context, cause) => console.error(`[square-hosted] ${context}:`, cause),
  });
}
