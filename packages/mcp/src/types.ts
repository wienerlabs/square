/**
 * An MCP server an agent may call tools on.
 *
 * Streamable HTTP only. stdio would mean spawning a process the agent's host
 * did not choose, and SSE is the transport the protocol deprecated; a server
 * an agent reaches over the network speaks Streamable HTTP or is not reached.
 */
export interface McpServerConfig {
  /**
   * Names the server in the tools it contributes: a tool `forecast` on a
   * server named `weather` is `weather__forecast` to the pool and to any
   * model the pool's tools are handed to. Letters, digits, `_` and `-`; no
   * `__`, which is the separator.
   */
  name: string;
  /** The Streamable HTTP endpoint. */
  url: string;
  /** Sent on every request, for a bearer token or an API key. */
  headers?: Record<string, string> | undefined;
}

/** JSON Schema, as MCP carries it: an object schema with no fixed shape beyond `type`. */
export type JsonSchemaObject = { type?: unknown; properties?: unknown; required?: unknown; [key: string]: unknown };

/** A tool as its server declared it, under the name it is called by here. */
export interface McpTool {
  /** `<server>__<tool>`. What `ToolPool.call` takes and what a model is shown. */
  name: string;
  /** The `McpServerConfig.name` it came from. */
  server: string;
  /** The name the server itself uses. */
  tool: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/**
 * Why a call did not produce a result. The pool never throws for these; a
 * tool that fails is a fact about the tool, and the caller (a handler, or a
 * model in a loop) decides what to do with it.
 */
export type ToolFailure =
  /** The server could not be reached, or dropped the connection. Retryable. */
  | "unreachable"
  /** The server did not answer within the call timeout, or the caller's signal aborted the wait. Retryable when it was the timeout. */
  | "timeout"
  /** No server in the pool declares the tool. Not retryable. */
  | "unknown-tool"
  /** The tool ran and reported an error (`isError`). Not retryable: the same input gets the same answer. */
  | "tool-error"
  /** The result was larger than `maxResultBytes`; `text` holds the truncated head. Not retryable. */
  | "too-large";

interface ToolOutcome {
  /** The qualified tool name the call was made with. */
  name: string;
  durationMs: number;
  /** Answered from the result cache, without a call. */
  cached: boolean;
  /** The result's text blocks, joined; on failure, the reason. */
  text: string;
}

export interface ToolSuccess extends ToolOutcome {
  ok: true;
  /** `structuredContent`, when the server sent one. */
  structured?: unknown;
}

export interface ToolFailed extends ToolOutcome {
  ok: false;
  failure: ToolFailure;
  retryable: boolean;
}

export type ToolResult = ToolSuccess | ToolFailed;
