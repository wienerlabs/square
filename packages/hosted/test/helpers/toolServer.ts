import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolServer {
  /** The Streamable HTTP endpoint. */
  url: string;
  /** Every tools/call the server received, in order. */
  calls: ToolCall[];
  /** Every HTTP request, including initialize and tools/list. */
  requests: number;
  /** Tool names declared per server instance. */
  close(): Promise<void>;
}

/**
 * A small MCP server over Streamable HTTP, the transport the pool speaks:
 * a weather tool, a slow one, one that errors, one that answers big, one
 * with structured content. Stateless, a fresh `McpServer` per request, the
 * way the SDK documents the stateless mode, so the pool's reconnects find
 * a server that keeps nothing between them.
 */
export async function startToolServer(options: { name?: string; hostname?: string } = {}): Promise<ToolServer> {
  const calls: ToolCall[] = [];
  const state = { requests: 0 };
  const build = (): McpServer => {
    const server = new McpServer({ name: options.name ?? "weather", version: "0.0.1" });
    server.registerTool(
      "forecast",
      { description: "Tomorrow's weather in a city.", inputSchema: { city: z.string(), days: z.number().optional() } },
      async ({ city, days }) => {
        calls.push({ tool: "forecast", args: days === undefined ? { city } : { city, days } });
        return { content: [{ type: "text", text: `${city}: sunny${days ? ` for ${days} days` : ""}` }] };
      },
    );
    server.registerTool("slow", { description: "Answers after ms.", inputSchema: { ms: z.number() } }, async ({ ms }) => {
      calls.push({ tool: "slow", args: { ms } });
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: "text", text: "done" }] };
    });
    server.registerTool("boom", { description: "Always fails." }, async () => {
      calls.push({ tool: "boom", args: {} });
      return { content: [{ type: "text", text: "the teapot is short and stout" }], isError: true };
    });
    server.registerTool("big", { description: "Answers with n bytes.", inputSchema: { n: z.number() } }, async ({ n }) => {
      calls.push({ tool: "big", args: { n } });
      return { content: [{ type: "text", text: "x".repeat(n) }] };
    });
    server.registerTool(
      "structured",
      { description: "Answers with structured content.", inputSchema: { q: z.string() }, outputSchema: { echo: z.string() } },
      async ({ q }) => {
        calls.push({ tool: "structured", args: { q } });
        return { content: [{ type: "text", text: `echo ${q}` }, { type: "resource_link", uri: "https://example.test/x", name: "x" }], structuredContent: { echo: q } };
      },
    );
    return server;
  };

  const app = new Hono();
  app.all("/mcp", async (c) => {
    state.requests += 1;
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = build();
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  const hostname = options.hostname ?? "127.0.0.1";
  const listening = serve({ fetch: app.fetch, port: 0, hostname });
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  const address = listening.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://${hostname}:${port}/mcp`,
    calls,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive connections from the pool's fetch would hold close() open.
        (listening as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        listening.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
