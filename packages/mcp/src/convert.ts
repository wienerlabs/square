import type { JsonSchemaObject, McpTool } from "./types.js";

/**
 * The same tools in the shapes the model APIs take.
 *
 * Descriptions are passed through, cut at a length, and nothing else. The
 * predecessor rewrote them through a list of "prompt injection" patterns
 * (`ignore previous instructions` became `[filtered]`); a description is
 * the server's text either way, a pattern list catches the phrasings its
 * author thought of, and a model that is told it was filtered trusts it
 * more than it should. The tool's name carries the server it came from, so
 * a model and its operator can see whose words they are reading.
 */
const MAX_DESCRIPTION = 1024;

export function describeTool(tool: McpTool): string {
  const text = tool.description.trim();
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text || `${tool.tool} on ${tool.server}`;
}

/** An object schema, as every tool's input schema is. */
export interface ObjectSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** The schema as an object schema, with the `$schema` header the SDK adds removed: the model APIs do not want it. */
function parameters(schema: JsonSchemaObject): ObjectSchema {
  const { $schema: _schema, required, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    properties: (rest.properties as Record<string, unknown> | undefined) ?? {},
    ...(Array.isArray(required) ? { required: required.filter((r): r is string => typeof r === "string") } : {}),
  };
}

/** The shape `@anthropic-ai/sdk`'s `Tool` takes; assignable to it. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ObjectSchema;
}

/** Anthropic Messages API `tools[]`. */
export function toolsForAnthropic(tools: readonly McpTool[]): AnthropicTool[] {
  return tools.map((tool) => ({ name: tool.name, description: describeTool(tool), input_schema: parameters(tool.inputSchema) }));
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: ObjectSchema };
}

/** OpenAI Chat Completions `tools[]`. */
export function toolsForOpenAI(tools: readonly McpTool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: describeTool(tool), parameters: parameters(tool.inputSchema) },
  }));
}

export interface GeminiTool {
  functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

/** Gemini `tools[]`: one entry holding every declaration. Gemini rejects `additionalProperties`, so it is removed at every depth. */
export function toolsForGemini(tools: readonly McpTool[]): GeminiTool {
  return {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: describeTool(tool),
      parameters: withoutAdditionalProperties(parameters(tool.inputSchema)) as Record<string, unknown>,
    })),
  };
}

function withoutAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdditionalProperties);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    out[key] = withoutAdditionalProperties(item);
  }
  return out;
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

/**
 * The arguments for a tool, from the one string an A2A task carries.
 *
 * `task/create` has `input: string` and an MCP tool takes an object, and
 * the predecessor bridged the two with a model that guessed the arguments
 * from the text. Guessing is the caller's job if it is anyone's: a JSON
 * object is taken as the arguments; any other text is taken as the value of
 * the tool's one string parameter, when it has exactly one; and a tool
 * that needs more is told so, with the names it needs.
 */
export function argumentsFor(tool: McpTool, input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    // Text that opens a JSON object either is one or is a mistake; it is not read as a string.
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      throw new ArgumentError(`input for ${tool.name} looks like JSON but does not parse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
  const names = Object.keys(properties);
  const required = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  if (names.length === 0) {
    if (trimmed === "") return {};
    throw new ArgumentError(`${tool.name} takes no arguments; the input must be empty or "{}"`);
  }
  // The one parameter plain text can mean: the only one, or the only required one.
  const single = names.length === 1 ? names[0] : required.length === 1 ? required[0] : undefined;
  if (single !== undefined && properties[single]?.type === "string") {
    if (trimmed === "") throw new ArgumentError(`${tool.name} needs ${single}; the input is empty`);
    return { [single]: trimmed };
  }
  throw new ArgumentError(
    `${tool.name} takes ${names.join(", ")}${required.length ? ` (required: ${required.join(", ")})` : ""}; pass them as a JSON object`,
  );
}

/** Dotted lowercase, the way docs/agent-card wants a capability id. */
const CAPABILITY_ID = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/**
 * A capability id for a tool: `<prefix>.<server>.<tool>`, each part folded to
 * the card's dotted-lowercase alphabet. `weather__get_forecast` under the
 * default prefix is `mcp.weather.get.forecast`. Two tools can fold to the
 * same id; `bridgeTools` refuses that rather than pick one.
 */
export function capabilityIdFor(tool: Pick<McpTool, "server" | "tool">, prefix = "mcp"): string {
  const fold = (part: string): string =>
    part
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
  const id = [prefix, tool.server, tool.tool].map(fold).filter((part) => part !== "").join(".");
  if (!CAPABILITY_ID.test(id) || id.length > 64) {
    throw new Error(`no capability id can be made for ${tool.server}__${tool.tool} under prefix ${JSON.stringify(prefix)}: got ${JSON.stringify(id)}`);
  }
  return id;
}
