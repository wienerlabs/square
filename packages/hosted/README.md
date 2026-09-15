# @squaresdk/hosted

An institution's agent, run by the platform from a configuration. Each capability is
a Claude run with the capability's instructions and the MCP tools the configuration
names; the whole thing is served as a `@squaresdk/agent` agent, so its tasks are
admitted against escrow and delivered by the on-chain `submit` like any other; and a
capability that is allowed to may hire other Square agents for subtasks, under the
policy the institution committed on chain.

```json
{
  "name": "Acme Research",
  "description": "Briefs, with sources.",
  "agentId": "7",
  "url": "https://research.acme.example",
  "provider": { "tier": "own", "apiKey": "sealed:v1:…" },
  "tools": [{ "name": "docs", "url": "https://docs.acme.example/mcp", "headers": { "authorization": "Bearer …" } }],
  "capabilities": [
    {
      "id": "research.brief",
      "description": "A one-page brief on a topic, with sources.",
      "price": "0.50",
      "instructions": "Write a one-page brief. Cite what the docs tool returns; delegate summaries of long sources.",
      "delegate": true
    }
  ],
  "delegation": { "allow": ["did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:8"], "maxPerJob": "0.25" },
  "compliance": { "policyFile": "policy.json", "proverUrl": "http://127.0.0.1:3003", "stateFile": "duty.json" }
}
```

```bash
SQUARE_PRIVATE_KEY=0x… SQUARE_SEAL_SECRET=… square-hosted acme.json
```

That is the whole deployment: the platform holds the wallet that owns the agent's
ERC-8004 id, the institution's configuration says what the agent does and with which
key, and the process serves the card at `/.well-known/agent-registration.json` and
tasks at `/a2a`.

## The run

A task reaches a capability the way it reaches any `@squaresdk/agent` capability:
`task/create` names a job the chain shows funded for this wallet, at or above the
capability's price. The handler is then a model run (`runCapability`):

- the system prompt is the capability's `instructions`, behind a fixed preamble naming
  the capability, so a multi-capability agent does the one it was paid for;
- the user turn is the task's `input`;
- the tools are the pool's MCP tools (`@squaresdk/mcp`, named `<server>__<tool>`), and
  `delegate` when the capability may hire;
- the model is `claude-opus-5` unless the provider names another, with adaptive
  thinking; every tool call of a turn is run and every result goes back in one user
  message, a failing tool marked `is_error` rather than dropped;
- the text of the final turn is what the agent delivers. Its hash goes on chain with
  the agent's `submit`.

A run that ends any other way, cut at `max_tokens`, refused, out of turns, is an error,
not a partial answer: the task fails with the reason, and the client's escrow returns
through the evaluator or expiry. An escrowed job is not delivered against half an
output.

## Whose key

| `provider.tier` | The model's key |
|---|---|
| `platform` | The platform's: `ANTHROPIC_API_KEY` in the host's environment, resolved by the Anthropic SDK itself, or the client the host passes to `hostAgent`. |
| `own` | The institution's, sealed in the configuration: AES-256-GCM under a key HKDF derives from the platform's `SQUARE_SEAL_SECRET`, bound to the agent's id so a sealed value copied into another agent's configuration does not open. `square-hosted seal <agentId>` seals a key read from stdin. |

The predecessor told a sealed key from a plain one by whether base64 decoded. Here a
value is sealed exactly when it starts with `sealed:v1:`, and a plain key where a
sealed one belongs is a configuration error, not a guess.

## Delegation

A capability with `delegate: true` gets a `delegate` tool. Calling it hires an agent
from the configuration's `delegation.allow` list, by DID or URL, through the same
path `@squaresdk/mcp`'s `square_hire` uses: `createJob` for the agent's wallet,
`setBudget`, `fund` from the hosted agent's own wallet, `task/create` over A2A, and a
wait. The model is told the job id, the task's state, the deliverable's hash and the
submit transaction; the work itself is not on the A2A wire
([docs/a2a](../../docs/a2a/README.md)), and the host can pass `resolveDeliverable` to
fetch the content behind a reference where there is a way to (a CID, an agent's own
channel). Delegations run one at a time across the agent, so the wallet signs one
hire at a time.

**The budget is the institution's policy**, not a number in this package:
[docs/decisions/delegation-allowance.md](../../docs/decisions/delegation-allowance.md).
Before every hire the allowance reads `PolicyRegistry.dailyLimit` and `spentToday`
for the hosted wallet, subtracts the delegated jobs it has funded that the chain has
not yet settled, and refuses what would go past the ceiling, in words the model can
repeat (`0.45 USDC is more than the policy allows today: ceiling 0.5, 0 released today,
0.1 in flight on 1 job(s), 0.4 available`). A wallet with no policy may delegate
nothing. `maxPerJob` bounds one job inside the same allowance. Nothing is refused
after escrow moved: an agent that refuses or fails the task after funding is reported
with the job that now holds the escrow.

**The proof is the hosted wallet's duty too.** On a stack whose hook holds a
compliance module, a delegated job's release needs a proof, bound by its client,
that the payment fits the client's policy; the client is this wallet. A
`compliance` block names the policy file (relative to the config; it holds the
policy's secret, so it sits beside the config and nowhere public) and the prover
that secret may be sent to. The host then runs a `ComplianceDuty` over every job it
delegates, for as long as it lives: once a job's window is within half the module's
tolerance of closing it binds a proof, rebinds if the payee, the net or the day's
counter move in between, and cranks the job when the window closes (square#349;
[docs/decisions/proof-freshness.md](../../docs/decisions/proof-freshness.md));
`hosted.duty` is that duty. The jobs survive the host (square#348): they are written,
with the capability and the budget each bought, to `stateFile` (default
`<config file>.duty.json`; `false` for none) on every change, read back at start, and
whatever the file does not hold the duty finds in this wallet's `JobCreated` logs; the
budgets read back are counted by the allowance again. Without the block, on such a
stack, every delegated release would pay this wallet back, so the block belongs with
the delegation block; the config parser refuses one without the other.

## In a host of your own

```ts
import { hostAgent, parseHostedConfig } from "@squaresdk/hosted";

const hosted = await hostAgent(parseHostedConfig(json), {
  walletClient, publicClient, rpcUrl,
  sealSecret: process.env.SQUARE_SEAL_SECRET,
  resolveDeliverable: async (task) => fetchFromGateway(task.deliverable),
});
await hosted.agent.listen(3000);
```

`hosted.agent` is the `@squaresdk/agent` agent (`card`, `app`, `client`, `listen`);
`hosted.allowance` is the delegation allowance (`view`, `inFlightJobs`, `restore`);
`hosted.duty` the release duty when `compliance` is given (as deps, `{ policy, prover }`,
or from the config's block by the binary); `hosted.tools` the MCP pool. `hostedHandlers` builds the capability handlers alone, for
a host that composes its own agent; `runCapability` is the model loop alone;
`PolicyAllowance` the allowance alone.

## Environment (`square-hosted`)

| | |
|---|---|
| `SQUARE_PRIVATE_KEY` | The wallet that owns the config's `agentId`. Required. |
| `SQUARE_CHAIN_ID`, `SQUARE_RPC_URL`, `SQUARE_DEPLOYMENT_FILE` | The chain, as for `square-mcp`: Arc Testnet by default, `31337` and a deployment file for anvil. |
| `SQUARE_SEAL_SECRET` | What own keys are sealed under; needed by `seal` and to run an own-key configuration. |
| `ANTHROPIC_API_KEY` | The platform tier's key. |
| `PORT`, `HOST` | `3000`, `0.0.0.0`. |

## Tests

```bash
npm test              # sealing, the configuration, the model loop against a scripted model, the allowance over a Map of a chain, the handlers with a real MCP server and a Hono agent to delegate to
npm run test:anvil    # the acceptance criteria of square#38 on anvil: a hosted agent takes a funded job, delegates a subtask under escrow from its own wallet within its policy, is refused past it, and the binary seals a key and serves a configuration
```

`test/compliance.test.ts` runs the delegation on a stack whose hook holds a
module keyed to a prover beside it, with a `compliance` block, and sees the
sub-agent paid the whole net once the host released the job; it skips, with
the reason, without that stack ([`@squaresdk/policy` README](../policy/README.md),
"the stack the tests run against").

The model in every test is scripted; nothing here calls the API. A run against the
real model is `hostAgent` with `ANTHROPIC_API_KEY` set, the way `square-hosted` runs it.
