# @squaresdk/mcp

[MCP](https://modelcontextprotocol.io) in both directions.

- **Agent → tool.** A `ToolPool` connects a Square agent to the MCP servers it may call
  tools on: lazily, one connection per server, let go when idle, every tool named
  `<server>__<tool>`. `bridgeTools` goes one step further and offers a server's tools as
  the agent's capabilities, so an MCP server is hireable through Square without anyone
  writing an agent for it.
- **Claude → agent.** `createSquareMcpServer` is Square as an MCP server, and `square-mcp`
  is it on stdio: Claude Desktop or Cursor looks an agent up by its `did:aip`, escrows a
  job for it on SquareJob and gives it the task, with no Square interface in between.

The predecessor's version of both lived in aip-beta's `src/lib/mcp/`. What changed is what
changed everywhere else in this repository: the bridge from task text to tool arguments no
longer asks a model to guess, the hiring tool funds an escrow instead of trusting a
report, and the caches are bounded.

## Agent → tool

```ts
import { createAgent } from "@squaresdk/agent";
import { bridgeTools, ToolPool } from "@squaresdk/mcp";

const tools = new ToolPool({
  servers: [{ name: "weather", url: "https://weather.example/mcp", headers: { authorization: `Bearer ${key}` } }],
});

// A handler that calls a tool.
agent.capability("weather.brief", {
  description: "Tomorrow's weather, in a sentence.",
  price: "0.05",
  handler: async ({ input }) => {
    const result = await tools.call("weather__forecast", { city: input });
    if (!result.ok) throw new Error(result.text);
    return result.text;
  },
});

// Or every tool the server declares, as a capability each: mcp.weather.forecast, ...
await bridgeTools(agent, tools, { price: "0.10" });
await agent.listen(3000);
```

`ToolPool` speaks Streamable HTTP and nothing else. A connection is made on the first
`tools()` or `call()` that needs it, so an agent configured with a server that is down
starts anyway and fails only the calls that reach it; after `idleMs` (a minute) without a
call the connection is closed, the server's tools are kept so `tools()` still answers, and
the next `call` reconnects. `status()` says where each server stands.

`call` never throws for a tool that fails. The result is `{ ok: true, text, structured? }`
or `{ ok: false, failure, retryable, text }`, where `failure` is one of `unreachable`,
`timeout` (both retryable), `unknown-tool`, `tool-error`, `too-large`. Successes are
remembered in a `ToolResultCache` (five minutes, 256 entries, least recently used out
first), keyed by the canonical JSON of the arguments; a failure is worth asking again
about, so it is not.

`toolsForAnthropic`, `toolsForOpenAI` and `toolsForGemini` give the same tools in the
shapes the model APIs take, for a handler that runs a model in a tool loop. Descriptions
are the server's text, cut at a length and not rewritten: the predecessor filtered them
through a list of "prompt injection" phrasings, which catches the phrasings its author
thought of and tells the model the rest are clean.

### `bridgeTools`

Each tool becomes one capability, `mcp.<server>.<tool>` folded to the card's dotted
lowercase (`weather__get_forecast` is `mcp.weather.get.forecast`). The handler turns the
task's `input` into the tool's arguments with `argumentsFor`: a JSON object is the
arguments; plain text is the value of the tool's one string parameter, when it has exactly
one, or its one required string parameter; a tool that needs more is told so, with the
names it needs, and the task fails with that. A tool that fails fails the task with the
pool's reason, because an escrowed job is not delivered against an error message. What is
delivered is the tool's text, hashed and submitted the way any capability's output is
(`@squaresdk/agent`).

## Claude → agent

### Running it

```json
{
  "mcpServers": {
    "square": {
      "command": "node",
      "args": ["/path/to/square/packages/mcp/dist/bin.js"],
      "env": { "SQUARE_PRIVATE_KEY": "0x…" }
    }
  }
}
```

That is a `claude_desktop_config.json` entry; Cursor's is the same shape. Build first
(`npm install --install-links && npm run build` in `packages/mcp`, after the packages it
depends on). The server defaults to Arc Testnet; the whole environment:

| | |
|---|---|
| `SQUARE_CHAIN_ID` | `5042002` (Arc Testnet) by default; `31337` for a local anvil. |
| `SQUARE_RPC_URL` | The chain's endpoint; defaults to the network profile's. |
| `SQUARE_DEPLOYMENT_FILE` | A `contracts/deployments/<chainId>.json`, for a local stack. |
| `SQUARE_PRIVATE_KEY` | The paying wallet. Without it the server only reads, and the tools that would spend are not offered. |
| `SQUARE_CALLER_DID` | The DID tasks are created under. Default the wallet's `did:pkh`. |
| `SQUARE_X402_MAX_PAYMENT` | Cap per x402 call, decimal USDC. `1.00` by default; `off` to not offer `square_call`. |
| `SQUARE_JOB_DAYS` | How long a hired job stays open. `7` by default. |

A key in an environment variable is a key in the process table, the same trade the CLI's
unattended mode makes; it is the one a desktop client offers. Use a wallet funded for
this.

### The tools

| | |
|---|---|
| `square_agent` | Look an agent up by `did:aip` or https URL: the ERC-8004 owner, whether it is active, its A2A endpoint, and every capability its card offers with its price. Read-only; the model is told to call it before hiring. |
| `square_hire` | Escrow a job for the agent and give it the task. `createJob` for the agent's wallet, `setBudget` with the capability's price (or `budget`), `fund`, then `task/create` over A2A and polling until the task ends or the wait runs out. Returns the job id, the task's state, and on `DELIVERED` the deliverable's hash and the `submit` transaction. |
| `square_task` | `task/status` at the agent, for a task `square_hire` handed back while it was still `WORKING`. |
| `square_job` | The job record: status, client, provider, budget, expiry, deliverable, the agent bound to it. |
| `square_call` | Pay a priced capability per call over x402 and return the output. Only for agents whose card says `x402Support`, and only with a wallet. |

Every answer comes back as text for the model and as `structuredContent` for a client
that reads JSON; a refusal is a result with `isError`, in words (`budget 0.01 is below the
price of text.summarize, 0.05 USDC; the agent would refuse the task`), so the model can
say why rather than retry.

### What a hire returns, and what it does not

A2A carries a reference to the deliverable, not the deliverable: the `bytes32` the agent's
`submit` puts on chain ([docs/a2a](../../docs/a2a/README.md)). So `square_hire` returns
that hash and the transaction, and the job it funded, and the evaluator settles the escrow
afterwards. The output itself is not on that wire. `square_call` is the tool that answers
with the output, because x402 is a payment for a response; an agent built with
`@squaresdk/agent` serves both from the same handler.

Identity comes from the chain and the offer from the card. The DID resolves to the
token's owner and to the services its on-chain registration file names; the card the
agent serves at its A2A origin's well-known path supplies the name, the capabilities and
the prices, and it must register the DID it was reached through, or the profile says it
does not. A price in another token or on another chain is treated as no price. The job is
created for the agent wallet when the registry has one set and for the owner otherwise;
SquareHook accepts a submit from either.

`square_hire` will not spend when it can see the hire failing: a capability the agent
does not offer, a budget below the price, a wallet that cannot cover it, an expiry inside
the settlement horizon (the agent's `submit` needs the horizon ahead of expiry), a
deactivated agent. Once the job is funded and the agent refuses or fails the task, the
answer says so and names the job: the escrow stays on it until the evaluator settles it
or it expires and `claimRefund` returns it. Hires run one at a time, because two
transactions signed from one wallet in the same instant can take the same nonce.

### In a host of your own

```ts
import { createSquareMcpServer } from "@squaresdk/mcp";

const server = createSquareMcpServer({ client, resolver, x402: { account, maxAmountPerPayment: "1.00" } });
await server.connect(transport); // stdio, or Streamable HTTP behind your own auth
```

`client` is a `@squaresdk/core` `SquareClient` (with a wallet to hire, without one to
read); `resolver` an `AipDidResolver`. `a2a`, `cards`, `callerDid`, `jobDays`,
`taskTimeoutMs` and `pollIntervalMs` are the knobs. `lookupAgent` is the lookup on its
own, and `hire` the escrow-and-dispatch on its own, with `admit` and `onFunded` hooks
for a host that keeps an allowance (`@squaresdk/hosted` does).

## Tests

```bash
npm test              # the pool against a real MCP server over Streamable HTTP, the cache, the conversions, the bridge, and the Square server through an in-memory MCP client over a Map of a chain
npm run test:anvil    # both directions at once: an agent whose capability is a bridged tool, hired through square-mcp spawned over stdio, on anvil with DeployLocal.s.sol
```
