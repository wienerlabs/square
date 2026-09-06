# `@squaresdk/a2a`

The task protocol: how work reaches an agent, how the result comes back, and
what neither of those does to the escrow.

No dependencies. No wallet, no chain client, no `amount` on the wire.

```ts
import { A2AClient, A2AServer, findA2AEndpoint } from "@squaresdk/a2a";
```

## Calling an agent

```ts
const endpoint = findA2AEndpoint(agentCard);      // the A2A entry in services[]
const client = new A2AClient();

const result = await client.runTask(endpoint, {
  taskId: "t-1",
  capability: "text.summarize",
  input: "…",
  callerDid: "did:aip:eip155:5042002:0x8004a818…bd9e:892271",
  jobId: "42",                                     // the ERC-8183 job
});

if (result.state === "DELIVERED") {
  // result.deliverable is a bytes32-shaped reference, ready for submit(jobId, …)
}
```

`runTask` dispatches, polls, and returns whatever the provider ended on —
including `FAILED`, which it returns rather than throws. A provider that could
not do the work has answered the question, and the caller's next move is the
same either way: wait for the evaluator.

Carried over from the predecessor and kept: retry with exponential backoff on
429 and 5xx only, `Retry-After` when the provider sends one, a per-endpoint
concurrency cap, and separate timeouts for dispatch and polling.

## Being an agent

```ts
const agent = new A2AServer({
  handlers: {
    "text.summarize": async ({ input, jobId }) => {
      const output = await summarise(input);
      return sha256(output);          // a reference to the work, not the work
    },
  },
});

// framework-free: parsed request in, response out
const response = await agent.handle(await req.json());
```

Resolving means delivered. Throwing means failed. There is no third option and
no `task/complete` method, because completion is not the provider's to declare.

## What it will not do

The agent's own report cannot move money. There is no settlement callback, no
signer, no chain dependency, and `task/create` carries no amount — a provider
that cannot see what it is owed cannot condition its behaviour on it.

`test/no-self-settlement.test.ts` enforces this against the shipped source
rather than in a comment: it fails if a `complete(`, `reject(`, `onSettle`,
`writeContract` or an `amount` field reappears.

## The state mapping

`DELIVERED` is not `Completed`. The provider's terminal success state means "I
delivered" and corresponds to calling `submit`, which takes the job from
`Funded` to `Submitted` and leaves the escrow where it is.

[`docs/a2a/README.md`](../../docs/a2a/README.md) has the full table and the
reasoning. `STATE_MAPPING` in `src/states.ts` is the same thing in code, and
`providerMayCall(state, action)` answers the question directly:

```ts
providerMayCall("DELIVERED", "submit");    // true — the only true
providerMayCall("DELIVERED", "complete");  // false
```

## Tests

```console
$ npm test
```

83 tests, no network. The end-to-end suite runs a real HTTP server and drives it
with the real client, so the handshake is exercised over a socket rather than
mocked.
