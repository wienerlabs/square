import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { A2AServer, type CapabilityHandler, type TaskSettlement } from "@squaresdk/a2a";
import { createSquareClient, type Screener, type SquareClient, type SquareDeployment, type SquareWalletClient } from "@squaresdk/core";
import { formatDid } from "@squaresdk/did-resolver";
import { createGatewayApp, networkOf, type GatewayHandler } from "@squaresdk/x402";
import type { FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import { getAddress, parseUnits, type Address, type PublicClient } from "viem";
import { a2aEndpointOf, registrationFile, type AgentType, type CardCapability, type RegistrationFile } from "./card.js";
import { squareSettlement } from "./settlement.js";

/** What a capability handler gets. Over A2A `jobId` and `callerDid` are the task's; over x402 there is no job and both are empty. */
export interface CapabilityCall {
  input: string;
  taskId: string;
  capability: string;
  jobId: string;
  callerDid: string;
  signal: AbortSignal;
}

export interface CapabilityOptions {
  description: string;
  /**
   * Decimal USDC, as a string ("0.05"). Two things follow from it: an A2A
   * task is admitted only against a job funded with at least this much, and
   * with `x402` configured the capability is also served per call at
   * `POST /pay/<id>` for exactly this much.
   */
  price?: string | undefined;
  handler: (call: CapabilityCall) => Promise<string>;
}

export interface X402Options {
  facilitator: FacilitatorClient;
  /** Defaults to the agent's own wallet. */
  payTo?: Address | undefined;
}

export interface AgentOptions {
  name: string;
  description: string;
  /** The provider: its wallet signs `submit`, and the jobs it takes are funded for its address. */
  walletClient: SquareWalletClient;
  publicClient: PublicClient;
  deployment?: SquareDeployment | undefined;
  /** The ERC-8004 agent this wallet owns. Every submit binds the job to it. */
  agentId: bigint;
  /** Public origin, for the card: `https://atlas.example`. */
  url: string;
  agentType?: AgentType | undefined;
  slug?: string | undefined;
  agentVersion?: string | undefined;
  image?: string | undefined;
  x402?: X402Options | undefined;
  maxConcurrent?: number | undefined;
  handlerTimeoutMs?: number | undefined;
  /**
   * The screener this wallet's `SquareClient` asks before it funds a job on
   * a hook that screens (square#368): an agent that delegates hires with the
   * same client it settles with. Serving jobs needs none.
   */
  screener?: Screener | undefined;
}

export interface Listening {
  url: string;
  close(): Promise<void>;
}

export interface Agent {
  readonly name: string;
  readonly address: Address;
  readonly did: string;
  readonly agentId: bigint;
  readonly client: SquareClient;
  readonly a2a: A2AServer;
  readonly settlement: TaskSettlement;
  /** Everything the agent serves, as a fetch handler; `listen` puts it on a port. */
  readonly app: Hono;
  capability(id: string, options: CapabilityOptions): Agent;
  card(): RegistrationFile;
  listen(port: number, hostname?: string): Promise<Listening>;
}

/**
 * An agent in a few lines: name it, give it the wallet that owns its ERC-8004
 * id, declare what it does, listen.
 *
 * What it serves:
 *
 *   GET  /.well-known/agent-registration.json   the card, per docs/agent-card
 *   POST /a2a                                   task/create and task/status, JSON-RPC 2.0
 *   POST /pay/<capability>                      the same handler per call, paid with x402 (when configured)
 *
 * The A2A tasks are the ones the escrow pays for. A task is admitted only
 * when the chain shows its job Funded for this wallet, above the
 * capability's price and not expired; the handler's output becomes the
 * `submit` that takes the job to Submitted, bound to `agentId`; and what the
 * evaluator does after that is read from the chain, never recorded here
 * (square#79). `capability` may be called after `createAgent` and before
 * `listen`; the card and the paid routes are built from what was declared.
 */
export function createAgent(options: AgentOptions): Agent {
  const client = createSquareClient({
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    ...(options.deployment !== undefined ? { deployment: options.deployment } : {}),
    ...(options.screener !== undefined ? { screener: options.screener } : {}),
  });
  const address = client.account;
  const deployment = client.deployment;
  const registry = deployment.identityRegistry.toLowerCase();
  const did = formatDid(deployment.chainId, registry, options.agentId);
  const network = networkOf(deployment.chainId);

  const capabilities = new Map<string, CapabilityOptions>();
  const handlers: Record<string, CapabilityHandler> = {};
  const settlement = squareSettlement({
    client,
    agentId: options.agentId,
    minimumBudgetFor: (id) => {
      const price = capabilities.get(id)?.price;
      return price === undefined ? undefined : parseUnits(price, 6);
    },
  });
  const a2a = new A2AServer({
    handlers,
    settlement,
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.handlerTimeoutMs !== undefined ? { handlerTimeoutMs: options.handlerTimeoutMs } : {}),
  });

  const cardCapabilities = (): CardCapability[] =>
    [...capabilities.entries()].map(([id, c]) => ({ id, description: c.description, ...(c.price !== undefined ? { price: c.price } : {}) }));

  const card = (): RegistrationFile =>
    registrationFile({
      name: options.name,
      description: options.description,
      url: options.url,
      did,
      agentId: options.agentId,
      agentRegistry: `eip155:${deployment.chainId}:${registry}`,
      token: deployment.usdc.toLowerCase(),
      network,
      capabilities: cardCapabilities(),
      agentType: options.agentType,
      slug: options.slug,
      agentVersion: options.agentVersion,
      image: options.image,
      x402Support: options.x402 !== undefined,
    });

  // The paid routes are fixed when the gateway is built, so it is built on
  // first use, after every capability() call; a capability declared later
  // than that is an error the way an undeclared one is.
  let gateway: Hono | undefined;
  const x402App = (): Hono => {
    if (gateway) return gateway;
    const x402 = options.x402;
    if (!x402) throw new Error("x402 is not configured on this agent");
    const routes: Record<string, { price: string; description?: string; handler: GatewayHandler }> = {};
    for (const [id, c] of capabilities) {
      if (c.price === undefined) continue;
      routes[`POST /pay/${id}`] = {
        price: c.price,
        description: c.description,
        handler: async (context) => {
          const body = (await context.req.json().catch(() => ({}))) as { input?: unknown };
          if (typeof body.input !== "string") return context.json({ error: "body must be { input: string }" }, 400);
          const output = await c.handler({
            input: body.input,
            taskId: randomUUID(),
            capability: id,
            jobId: "",
            callerDid: "",
            signal: new AbortController().signal,
          });
          return context.json({ capability: id, output });
        },
      };
    }
    gateway = createGatewayApp({
      payTo: getAddress(x402.payTo ?? address),
      network,
      facilitator: x402.facilitator,
      routes,
      asset: deployment.usdc,
    });
    return gateway;
  };

  const app = new Hono();
  app.get("/.well-known/agent-registration.json", (c) => c.json(card()));
  app.post("/a2a", async (c) => {
    let request: unknown;
    try {
      request = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "body is not JSON" }, id: null });
    }
    // No caller identity is asserted here: the body's callerDid is taken at
    // its word. A deployment that authenticates callers passes what it knows
    // to `a2a.handle` from its own middleware.
    return c.json(await a2a.handle(request));
  });
  app.all("/pay/*", (c) => (options.x402 ? x402App().fetch(c.req.raw) : c.json({ error: "x402 is not configured" }, 404)));

  const agent: Agent = {
    name: options.name,
    address,
    did,
    agentId: options.agentId,
    client,
    a2a,
    settlement,
    app,
    capability(id, capabilityOptions) {
      if (gateway !== undefined) throw new Error(`capability ${id} declared after the paid routes were built; declare capabilities before serving`);
      capabilities.set(id, capabilityOptions);
      handlers[id] = (task) => capabilityOptions.handler(task);
      return agent;
    },
    card,
    async listen(port, hostname = "0.0.0.0") {
      card();
      const server = serve({ fetch: app.fetch, port, hostname });
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const bound = server.address();
      const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;
      return {
        url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${actualPort}`,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      };
    },
  };
  return agent;
}

export { a2aEndpointOf };
