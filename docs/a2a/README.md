# A2A tasks, and what they mean on chain

Escrow locks the money. A compliance proof unlocks it. This is the part in
between: how work reaches an agent and how the result comes back.

There are two state machines here and they belong to different parties. Reading
one as the other is the mistake this document exists to prevent.

## The two machines

**The task** is what the provider says about its own work. It is a claim,
carried over HTTP, and the provider is its only author.

**The job** is what the chain says about the money. ERC-8183 lets the provider
move it exactly one step and no further.

| task state | the provider is saying | job status | what the provider may call |
|---|---|---|---|
| `SUBMITTED` | nothing yet; work has been dispatched | `Funded` | — |
| `WORKING` | I have the work | `Funded` | — |
| `DELIVERED` | I am done | `Funded` | `submit` |
| `FAILED` | I cannot do it | `Funded` | — |
| `CANCELLED` | the caller withdrew before I acknowledged | `Funded` | — |

Every row says `Funded`. That is the point: nothing a provider says over HTTP
moves the escrow.

## The collision

A2A's terminal success state used to be called `COMPLETED`. ERC-8183 also has a
`Completed`. **They are not the same thing**, and they are one careless reading
apart:

```
A2A     DELIVERED   "I have done the work"
8183    Submitted   the job is awaiting evaluation, escrow untouched

8183    Completed   the escrow has been paid out to the provider
```

An agent reaching `DELIVERED` calls `submit(jobId, deliverable)`, which takes
the job from `Funded` to `Submitted`. That is the end of its authority. Only the
job's evaluator may call `complete` or `reject`, and the contract reverts for
anybody else.

The state is called `DELIVERED` rather than `COMPLETED` for exactly this reason.
The two words are not interchangeable and the code should not let them look it.

## What changed from the predecessor

`aip-beta` had the agent's self-report drive settlement. The dispatcher took an
`onSettle` callback and called it the moment the provider's own status poll came
back:

```ts
// aip-beta/src/lib/protocol/a2a-dispatcher.ts
if (result.status === "COMPLETED" && result.artifact) {
  const settlementTxHash = await onSettle("release");   // <- the provider's word
  completeTask(taskId, result.artifact, settlementTxHash);
} else {
  await onSettle("refund");
}
```

and the state machine narrated it:

```ts
// aip-beta/src/lib/protocol/task-machine.ts
addLog(task, "COMPLETE", `${task.amount} USDC released to ${task.agentName}`);
```

The agent said "done" and the money moved. That is gone. `@squaresdk/a2a` has no
settlement callback, no wallet, no chain dependency, and no `amount` on the
wire — `packages/a2a/test/no-self-settlement.test.ts` scans the shipped source
and fails if any of them come back.

Removing `amount` from `task/create` is deliberate beyond hygiene: a provider
that cannot see what it is owed cannot condition its behaviour on it. `jobId`
replaces it, which is what the provider actually needs in order to `submit`, and
which a public chain already publishes.

## The wire

JSON-RPC 2.0 over HTTP POST. Two methods, and two deliberate absences.

| method | direction | |
|---|---|---|
| `task/create` | caller → provider | dispatch; the provider acknowledges immediately and works in the background |
| `task/status` | caller → provider | poll until a terminal state |

There is no `task/complete`. Completion is not the provider's to declare.

There is no `task/cancel` either, for a different reason: see below.

The request `id` is echoed as received. JSON-RPC 2.0 allows a string, a
number or null, and a caller with several requests in flight matches answers
to questions by it; a request with no usable id gets `null` back.

`task/create` carries `taskId`, `capability`, `input`, `callerDid` and `jobId`.
The `deliverable` that comes back on `DELIVERED` is a reference to the work
rather than the work itself, sized for ERC-8183's `bytes32` — a hash or a CID.
Keeping the same shape on the wire and on chain stops the two from drifting.

## Cancellation has no window

The state machine allows a cancel from `SUBMITTED` and from nowhere else. Once
the provider has acknowledged, the work may already be done, and the escrow
settles through the evaluator either way, so "cancelled" would be a claim about
the world that the caller is not in a position to make.

On this server the window that rule leaves open is empty. `task/create`
creates the task and acknowledges it before it answers, so a caller never
observes a task in `SUBMITTED`; the first state it can see is `WORKING`. A
`task/cancel` method here could only ever answer `-32602`, which is why the
wire does not carry one and `A2AClient` does not offer one.

`TaskMachine.cancel` and the `CANCELLED` state stay. They are for a host that
holds the machine directly, through `A2AServerOptions.machine`, and chooses to
create tasks without accepting them at once. That host has a real window, and
it is the host's to close.

## Discovery

The caller does not get handed a URL. It resolves the agent's `did:aip`, reads
the DID Document's services, and takes the entry named `A2A`. The card shape is
[`docs/agent-card/schema.json`](../agent-card/schema.json).

Endpoints must be `https`, with one exception for loopback so that an agent can
be written on `localhost` before it is deployed. A task request carries the work
and the job id; over plain http both are rewritable by anyone on the path.

The rule is about the address as well as the scheme, because the endpoint is
the other side's choice and the caller contacts it unprompted, for the card at
`/.well-known/agent-registration.json`. A literal private, link-local or
otherwise non-public address is refused whatever the scheme:
`https://169.254.169.254/` is not an agent. Loopback is the development
exception, on http and https both. Hostnames are not resolved by this package,
which has no dependencies; a host that must not reach its own network through a
card it did not write passes `WellKnownCache` a `fetch` built on
`@squaresdk/hardening`'s `safeFetch`.

Redirects: the well-known request follows at most three, each target held to
the same rule; a task request follows none, and a 3xx on it is a provider error.

## Failure is not refund

A provider that reports `FAILED` has said something about its own work and
nothing about the money. The job stays `Funded`. What happens next is the
evaluator's `reject`, or `expiredAt` passing and anyone calling `claimRefund`.
The protocol layer neither triggers nor predicts either.

The client reflects this: `runTask` returns a `FAILED` result rather than
throwing, because the caller's next move is the same whether the provider
delivered or gave up — wait for the evaluator.

## Where the numbers come from

The job status values are the contract's enum ordering, checked against the
deployed ERC-8183 registry on Arc Testnet
(`0x0747EEf0706327138c69792bF28Cd525089e4583`) rather than read off the ERC:
sampling the first forty jobs returns statuses 0, 1 and 3, which under this
ordering are `Open`, `Funded` and `Completed`, and nothing else appears.

| | |
|---|---|
| `Open` | 0 |
| `Funded` | 1 |
| `Submitted` | 2 |
| `Completed` | 3 |
| `Rejected` | 4 |
| `Expired` | 5 |
