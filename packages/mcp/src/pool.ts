import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolResultCache } from "./cache.js";
import type { JsonSchemaObject, McpServerConfig, McpTool, ToolFailed, ToolResult, ToolSuccess } from "./types.js";

export interface ToolPoolOptions {
  servers: readonly McpServerConfig[];
  /** A server nobody has called for this long is disconnected; the next call reconnects. Default one minute. */
  idleMs?: number | undefined;
  /** Longest one tool call may take. Default 30 s. */
  callTimeoutMs?: number | undefined;
  /** Longest connecting and listing a server's tools may take. Default 10 s. */
  connectTimeoutMs?: number | undefined;
  /** Largest result text passed on. Default 100 KiB. */
  maxResultBytes?: number | undefined;
  /** Where successful results are remembered. `false` for none; default a `ToolResultCache` with its defaults. */
  cache?: ToolResultCache | false | undefined;
  /**
   * What the transport requests with. The platform's fetch by default, which
   * follows the server's URL wherever the config points it; a host that must
   * not reach its own network through a URL it did not write passes one
   * built on `@squaresdk/hardening`'s `safeFetch`.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /** How the pool introduces itself to servers. */
  clientInfo?: { name: string; version: string } | undefined;
  /** Where a server's connection failure is reported. `tools()` skips a server that fails; this is the only trace. */
  onError?: ((server: string, error: unknown) => void) | undefined;
  now?: (() => number) | undefined;
}

export type ServerState = "disconnected" | "connecting" | "connected" | "failed";

export interface ServerStatus {
  name: string;
  url: string;
  state: ServerState;
  /** Tools last discovered on it, kept across an idle disconnect. */
  tools: number;
  lastError?: string;
}

/** Letters, digits, `_` and `-`, and never the `__` that separates the server from the tool. */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SEPARATOR = "__";

interface Connection {
  client: Client;
  tools: McpTool[];
  idle: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The agent's side of MCP: the servers it may call tools on, connected when
 * first needed and let go when idle.
 *
 * A connection is made on the first `tools()` or `call()` that needs it,
 * not when the pool is built, so an agent configured with a server that is
 * down starts anyway and fails only the calls that reach it. After `idleMs`
 * without a call the connection is closed and the server's tools are kept,
 * so `tools()` keeps answering from what was discovered and the next `call`
 * reconnects. Every tool is named `<server>__<tool>`: two servers declaring
 * a `search` do not collide, and a call names the server it means.
 *
 * `call` never throws for a tool that fails. The result says whether it
 * succeeded, and if not, why and whether asking again could help; a handler
 * that wants a failure to fail its task throws on `!ok` itself.
 */
export class ToolPool {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly live = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly known = new Map<string, McpTool[]>();
  private readonly failures = new Map<string, string>();
  private readonly cache: ToolResultCache | undefined;
  private readonly idleMs: number;
  private readonly callTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxResultBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly clientInfo: { name: string; version: string };
  private readonly onError: ((server: string, error: unknown) => void) | undefined;
  private readonly now: () => number;
  private closed = false;

  constructor(options: ToolPoolOptions) {
    for (const server of options.servers) {
      if (!SERVER_NAME.test(server.name) || server.name.includes(SEPARATOR)) {
        throw new Error(`MCP server name ${JSON.stringify(server.name)} must be letters, digits, _ or -, without "__"`);
      }
      if (this.servers.has(server.name)) throw new Error(`MCP server ${server.name} is configured twice`);
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        throw new Error(`MCP server ${server.name}: ${JSON.stringify(server.url)} is not a URL`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`MCP server ${server.name}: ${server.url} is not an http(s) URL`);
      }
      this.servers.set(server.name, server);
    }
    this.cache = options.cache === false ? undefined : (options.cache ?? new ToolResultCache());
    this.idleMs = options.idleMs ?? 60_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.maxResultBytes = options.maxResultBytes ?? 100 * 1024;
    this.fetchImpl = options.fetch;
    this.clientInfo = options.clientInfo ?? { name: "@squaresdk/mcp", version: "0.1.0" };
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
  }

  /** `<server>__<tool>`, the name a tool is called by. */
  static qualify(server: string, tool: string): string {
    return `${server}${SEPARATOR}${tool}`;
  }

  /**
   * Every tool every server declares, discovering each server on first use.
   * A server that cannot be reached contributes nothing and is reported
   * through `onError` and `status()`, not thrown: one server being down is
   * not a reason for an agent to have no tools. `refresh` rediscovers.
   */
  async tools(options: { refresh?: boolean } = {}): Promise<McpTool[]> {
    this.assertOpen();
    const out: McpTool[] = [];
    for (const name of this.servers.keys()) {
      const known = this.known.get(name);
      if (known !== undefined && !options.refresh) {
        out.push(...known);
        continue;
      }
      try {
        const connection = await this.connect(name, options.refresh === true);
        out.push(...connection.tools);
      } catch {
        // Recorded by connect(); the server answers status() as failed.
      }
    }
    return out;
  }

  /** The servers and where each stands. */
  status(): ServerStatus[] {
    return [...this.servers.values()].map((server) => {
      const live = this.live.get(server.name);
      const state: ServerState = live
        ? "connected"
        : this.connecting.has(server.name)
          ? "connecting"
          : this.failures.has(server.name)
            ? "failed"
            : "disconnected";
      const lastError = this.failures.get(server.name);
      return {
        name: server.name,
        url: server.url,
        state,
        tools: (live?.tools ?? this.known.get(server.name) ?? []).length,
        ...(lastError !== undefined ? { lastError } : {}),
      };
    });
  }

  /**
   * Call a tool by its qualified name. Connects if the server is not
   * connected, answers from the cache when it can, and classifies what went
   * wrong when something did.
   */
  async call(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    this.assertOpen();
    const started = this.now();
    const failed = (failure: ToolFailed["failure"], text: string, retryable: boolean): ToolFailed => ({
      ok: false,
      failure,
      retryable,
      name,
      text,
      durationMs: this.now() - started,
      cached: false,
    });

    const at = name.indexOf(SEPARATOR);
    const server = at > 0 ? name.slice(0, at) : "";
    const tool = at > 0 ? name.slice(at + SEPARATOR.length) : "";
    if (!server || !tool || !this.servers.has(server)) {
      return failed("unknown-tool", `no server in the pool is named in ${JSON.stringify(name)}; tools are called as <server>__<tool>`, false);
    }

    const cached = this.cache?.get(name, args);
    if (cached) return cached;

    let connection: Connection;
    try {
      connection = await this.connect(server, false);
    } catch (error) {
      return failed("unreachable", `${server} could not be reached: ${messageOf(error)}`, true);
    }
    if (!connection.tools.some((t) => t.tool === tool)) {
      return failed("unknown-tool", `${server} declares no tool named ${JSON.stringify(tool)}`, false);
    }

    this.touch(server, connection);
    let result: CallToolResult;
    try {
      result = (await connection.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout: options.timeoutMs ?? this.callTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      )) as CallToolResult;
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        return failed("timeout", `${name} did not answer within ${options.timeoutMs ?? this.callTimeoutMs}ms`, true);
      }
      if (options.signal?.aborted) {
        return failed("timeout", `${name} was aborted by the caller`, false);
      }
      // Anything else is the connection: the transport failed, or the server
      // answered with a protocol error. Dropped so the next call starts over.
      this.drop(server);
      return failed("unreachable", `${name} failed: ${messageOf(error)}`, true);
    }
    this.touch(server, connection);

    const text = textOf(result);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > this.maxResultBytes) {
      const head = new TextDecoder().decode(bytes.subarray(0, this.maxResultBytes));
      return failed("too-large", head, false);
    }
    if (result.isError) return failed("tool-error", text || `${name} reported an error without saying what`, false);

    const success: ToolSuccess = {
      ok: true,
      name,
      text,
      durationMs: this.now() - started,
      cached: false,
      ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    };
    this.cache?.set(name, args, success);
    return success;
  }

  /** Disconnect everything. The pool cannot be used afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.connecting.values()];
    await Promise.allSettled(pending);
    for (const name of [...this.live.keys()]) this.drop(name);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("the tool pool is closed");
  }

  private touch(server: string, connection: Connection): void {
    if (connection.idle) clearTimeout(connection.idle);
    connection.idle = setTimeout(() => this.drop(server), this.idleMs);
    // Idle timers must not keep an agent process alive by themselves.
    connection.idle.unref?.();
  }

  private drop(server: string): void {
    const connection = this.live.get(server);
    if (!connection) return;
    if (connection.idle) clearTimeout(connection.idle);
    this.live.delete(server);
    void connection.client.close().catch(() => undefined);
  }

  private connect(server: string, refresh: boolean): Promise<Connection> {
    const live = this.live.get(server);
    if (live && !refresh) return Promise.resolve(live);
    const pending = this.connecting.get(server);
    if (pending) return pending;
    if (live) this.drop(server);
    const attempt = this.open(server).finally(() => this.connecting.delete(server));
    this.connecting.set(server, attempt);
    return attempt;
  }

  private async open(server: string): Promise<Connection> {
    const config = this.servers.get(server);
    if (!config) throw new Error(`no MCP server named ${server}`);
    const client = new Client(this.clientInfo);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    try {
      // The SDK's transport declares `sessionId: string | undefined` against
      // an interface that says `sessionId?: string`; under
      // exactOptionalPropertyTypes those differ, and the cast is the whole
      // of the disagreement.
      await client.connect(transport as unknown as Transport, { timeout: this.connectTimeoutMs });
      const tools = await this.discover(server, client);
      const connection: Connection = { client, tools, idle: undefined };
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw new Error("the tool pool is closed");
      }
      this.failures.delete(server);
      this.known.set(server, tools);
      this.live.set(server, connection);
      this.touch(server, connection);
      return connection;
    } catch (error) {
      this.failures.set(server, messageOf(error));
      this.onError?.(server, error);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /** Every page of `tools/list`. */
  private async discover(server: string, client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.connectTimeoutMs });
      for (const tool of page.tools) {
        tools.push({
          name: ToolPool.qualify(server, tool.name),
          server,
          tool: tool.name,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema as JsonSchemaObject) ?? { type: "object" },
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }
}

/** The text blocks of a tool result, joined; other block types are named, not dropped silently. */
export function textOf(result: Pick<CallToolResult, "content">): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") parts.push(block.text);
    else parts.push(`[${block.type}]`);
  }
  return parts.join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
