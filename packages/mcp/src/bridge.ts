import type { CapabilityOptions } from "@squaresdk/agent";
import { argumentsFor, capabilityIdFor, describeTool } from "./convert.js";
import type { ToolPool } from "./pool.js";
import type { McpTool } from "./types.js";

export interface BridgeOptions {
  /** The first segment of every capability id. Default `mcp`. */
  prefix?: string | undefined;
  /**
   * Decimal USDC per task, for every tool or per tool. A tool priced this
   * way is admitted only against a job funded with at least that much, and
   * served per call through x402 when the agent has it. Unpriced tools take
   * any funded amount.
   */
  price?: string | ((tool: McpTool) => string | undefined) | undefined;
  /** Which tools to offer. Default all the pool discovers. */
  include?: ((tool: McpTool) => boolean) | undefined;
}

/** What the bridge needs of an agent: `createAgent`'s `capability`, and nothing else. */
export interface CapabilityHost {
  capability(id: string, options: CapabilityOptions): unknown;
}

export interface BridgedCapability {
  id: string;
  tool: McpTool;
  price?: string;
}

/**
 * Offer the tools a pool discovers as the capabilities of an agent, so that
 * an MCP server is hireable through Square without writing an agent for it.
 *
 * Each tool becomes one capability, `mcp.<server>.<tool>`, whose handler
 * turns the task's input into the tool's arguments (`argumentsFor`), calls
 * the tool, and delivers its text; the agent's settlement then hashes that
 * text and puts it on chain with `submit`, the way it does any other
 * capability's output. A tool that fails fails the task, with the pool's
 * reason: an escrowed job is not delivered against an error message.
 *
 * Discovery happens here, so the pool connects to every server before the
 * agent listens; a server that is down at that moment contributes nothing
 * and is reported through the pool's `onError`. Declared before `listen`,
 * like any capability.
 */
export async function bridgeTools(
  agent: CapabilityHost,
  pool: ToolPool,
  options: BridgeOptions = {},
): Promise<BridgedCapability[]> {
  const priceOf = (tool: McpTool): string | undefined =>
    typeof options.price === "function" ? options.price(tool) : options.price;
  const tools = (await pool.tools()).filter((tool) => options.include?.(tool) ?? true);
  const seen = new Map<string, McpTool>();
  const bridged: BridgedCapability[] = [];
  for (const tool of tools) {
    const id = capabilityIdFor(tool, options.prefix);
    const other = seen.get(id);
    if (other) {
      throw new Error(`${other.name} and ${tool.name} both fold to capability ${id}; exclude one with include()`);
    }
    seen.set(id, tool);
    const price = priceOf(tool);
    const capability: CapabilityOptions = {
      description: describeTool(tool),
      price,
      handler: async ({ input, signal }) => {
        const args = argumentsFor(tool, input);
        const result = await pool.call(tool.name, args, { signal });
        if (!result.ok) throw new Error(`${tool.name} ${result.failure}: ${result.text}`);
        return result.text;
      },
    };
    agent.capability(id, capability);
    bridged.push({ id, tool, ...(price !== undefined ? { price } : {}) });
  }
  return bridged;
}
