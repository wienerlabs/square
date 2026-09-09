# SquareHook: one hook, selector routing, and the shared `optParams`

**Status:** design, decided in [#53][i53]. Binds the compliance hook in
[#27][i27], reputation in [#23][i23], the claim market in [#29][i29], arbitration
in [#22][i22], and the whitelist rule in the kernel ([#20][i20]) and its storage
([#6][i6], [storage-and-events.md](./storage-and-events.md)).

[i6]: https://github.com/wienerlabs/square/issues/6
[i20]: https://github.com/wienerlabs/square/issues/20
[i22]: https://github.com/wienerlabs/square/issues/22
[i23]: https://github.com/wienerlabs/square/issues/23
[i27]: https://github.com/wienerlabs/square/issues/27
[i29]: https://github.com/wienerlabs/square/issues/29
[i53]: https://github.com/wienerlabs/square/issues/53

ERC-8183 gives a job exactly one hook address. Four subsystems need to be on the
settlement path, and none of them can own that address alone:

| Subsystem | What it needs from the path |
|---|---|
| Compliance (#27) | verify a proof before the release, bound to the address that will actually be paid |
| Reputation (#23) | write to ERC-8004 after a terminal state |
| Claim market (#29) | route the release to the buyer when the receivable was sold |
| Arbitration (#22) | express a partial split, which the evaluator seat cannot |

So there is one contract, `SquareHook`, and it routes on the selector. This
document fixes its interface, the order of the four concerns, the layout of the
`optParams` bytes they share, the whitelist that makes the kernel safe to hook,
and the gas limit the kernel forwards.

## Interfaces

Two, both implemented by `SquareHook`. The first is ERC-8183's, unchanged. The
second is ours and is the answer to "how does a hook split a payment without
touching escrow state".

```solidity
interface IACPHook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// Consulted by the kernel at complete(), before beforeAction, to learn where the
/// provider-side share goes and how large it is. View: it cannot write anything.
interface IPayoutResolver is IERC165 {
    function resolvePayout(uint256 jobId, bytes calldata data)
        external view returns (address payee, uint16 providerBps);
}
```

The kernel checks `supportsInterface` for both at `createJob`. `IACPHook` is
mandatory for any non-zero hook; `IPayoutResolver` is optional, and a hook
without it gets the default routing (`payee = provider`, `providerBps = 10 000`).

`resolvePayout` is a `view` on purpose. ERC-8183 says hooks "MUST NOT modify
core escrow state directly". The alternative designs all had the hook writing
into the kernel during a callback; a read-only query the kernel validates
(`payee != 0`, `providerBps <= 10 000`) keeps the amount conserved by the kernel
and the decision in the hook. The kernel emits `PayoutRouted` with what it
decided, so the split is auditable from the log alone.

## The `data` argument, per selector

The kernel encodes `data` exactly as the ERC-8183 table says. (The reference
implementation prepends `msg.sender`; the specification table is normative and
does not, and we follow the specification.)

| Kernel function | `data` |
|---|---|
| `setProvider(jobId, provider, optParams)` | `abi.encode(address provider, bytes optParams)` |
| `setBudget(jobId, amount, optParams)` | `abi.encode(uint256 amount, bytes optParams)` |
| `fund(jobId, expectedBudget, optParams)` | `optParams` (raw) |
| `submit(jobId, deliverable, optParams)` | `abi.encode(bytes32 deliverable, bytes optParams)` |
| `complete(jobId, reason, optParams)` | `abi.encode(bytes32 reason, bytes optParams)` |
| `reject(jobId, reason, optParams)` | `abi.encode(bytes32 reason, bytes optParams)` |
| `claimRefund(jobId)` | **not hookable** |

## `optParams` layout

The kernel never decodes `optParams`. `SquareHook` decodes it per selector, and
each layout is owned by exactly one caller so the four subsystems never contend
for the same bytes.

### `submit`: the provider binds its agent

```
optParams = ""                                              no agent, no reputation
optParams = abi.encode(uint256 agentId, bytes32 validationRequestHash)
```

Encoded by the provider (the SDK does it). The hook verifies that the ERC-8004
agent belongs to the provider: `IdentityRegistry.ownerOf(agentId) == provider`
or, when the registry exposes it, `getAgentWallet(agentId) == provider`. A
mismatch reverts the submit, because a provider must not be able to credit
someone else's agent. `validationRequestHash` may be zero; when set, it is the
`requestHash` of a `ValidationRegistry.validationRequest(validator = SquareHook,
…)` the agent owner made, which is what lets the hook answer it later.

### `complete`: the evaluator carries the split, the keeper carries the proof

```
optParams = abi.encode(uint16 providerBps, bytes complianceProof)
```

Encoded by `KeeperEvaluator`, the only evaluator the whitelisted hook is used
with. `providerBps` is `10 000` on the optimistic path and whatever the
arbitration decided otherwise. `complianceProof` is opaque to the hook and is
handed to the compliance module unchanged; its inner layout (Groth16 proof and
the eight public signals) is #27's. Empty bytes are valid while no module is
installed.

### `reject`

```
optParams = ""                          or   abi.encode(bytes32 evidence)
```

Unused by the hook today; reserved so a later rejection reason can travel
without an interface change.

### `setProvider`, `setBudget`, `fund`

Empty. The hook does nothing on these selectors. Compliance gates the
**release**, not the deposit: a policy proof at `fund` would prove nothing about
what the money is eventually spent on.

## Routing table and order

`msg.sig` of the kernel function, as ERC-8183 prescribes.

| Selector | `resolvePayout` (view, first) | `beforeAction` (may revert) | kernel | `afterAction` (side effects) |
|---|---|---|---|---|
| `setProvider` | – | no-op | state | – |
| `setBudget` | – | no-op | state | – |
| `fund` | – | no-op | pulls USDC | – |
| `submit` | – | decode `agentId`, verify ownership, store `agentOf[jobId]`, `validationOf[jobId]`; emit `AgentBound` | Submitted | – |
| `complete` | `payee = ClaimMarket.payeeOf(jobId)`; `providerBps` from `optParams` | recompute `payee` and `providerShare`; `complianceModule.checkRelease(jobId, payee, providerShare, token, client, proof)` if a module is installed; emit `ComplianceChecked` | credit ledger, emit normative events | `giveFeedback(agentOf[jobId], +1, "square", "completed", …, reason)`; `validationResponse(requestHash, 100, …)` when a proof was verified; emit `ReputationRecorded` / `ValidationRecorded` |
| `reject` | – | no-op | refund credit | if the job was Submitted: `giveFeedback(agentOf[jobId], −1, …, "rejected")`, `validationResponse(requestHash, 0, …)`; otherwise nothing |
| `claimRefund` | not hookable | | refund credit, Expired | not hookable; `SquareHook.recordExpiry(jobId)` is permissionless and writes the neutral feedback once the kernel reports `Expired` |

The order inside `complete` is the whole point of the unified hook:

1. **Routing first.** The kernel asks `resolvePayout` before anything else, so
   the address the proof must name is the address the kernel will credit. When
   the receivable was sold, that is the buyer. A compliance check that bound the
   proof to `provider` would reject every sold receivable, or would bind to an
   address that never receives the money.
2. **Compliance second**, in `beforeAction`, against the routed `payee` and the
   routed `providerShare` (net × bps). A revert here blocks the release and
   nothing has changed.
3. **Kernel third.** Status, ledger, events.
4. **Reputation last**, in `afterAction`, credited to `agentOf[jobId]`: the
   agent that did the work. The payee is irrelevant here. Money is transferable;
   evidence of work is not (#23, #29).

`beforeAction(complete)` and `resolvePayout` compute the same `(payee,
providerShare)` from the same inputs. They are two calls because one is a view
the kernel needs a return value from and the other is where a revert belongs.

## Registry writes never block settlement

`giveFeedback` and `validationResponse` are calls into ERC-8004's upgradeable
registries. They are wrapped in `try/catch`. On failure the hook emits
`ReputationWriteFailed` or `ValidationWriteFailed` with the revert data and the
kernel's `complete` still lands. An `afterAction` that reverted here would roll
back a settlement because a side registry misbehaved, which is the wrong
priority: the money decision is the kernel's, the reputation signal is
advisory.

That trade is only defensible while something reads the event, so the reader is
named here. **`services/indexer`** decodes both events as it applies a batch,
logs `indexer.hook_write_failed` at `error` and counts them into
`square_hook_write_failures_total{kind}` with `kind` set to `reputation` or
`validation`. The indexer's alerting carries the `hookWriteFailures` rule from
`packages/observability`, which fires on the first one rather than on a rate,
because a registry that starts refusing writes is not a rate problem. The raw
event stays queryable in `job_events` either way.

`recordExpiry(jobId)` and every write path also guard with `recorded[jobId]`
so one job yields at most one feedback entry.

## Whitelist

ERC-8183 treats the hook as client-supplied and trusted, and accepts by design
that a reverting hook blocks every hookable action until `expiredAt`. We do not
give clients that freedom. The kernel keeps `whitelistedHooks[address]`, owner-
managed, and `createJob` reverts with `HookNotWhitelisted` for any other
address. `address(0)` is an entry in the same map, `true` at deployment, so a
deployment may later refuse un-hooked jobs by setting it `false`.

Consequences carried into the other designs:

- **#6 / storage:** `whitelistedHooks` is contract-wide storage on the kernel,
  and the `hook` field of a job is immutable after `createJob`.
- **#20 / kernel acceptance:** a `createJob` with a non-whitelisted hook must
  revert, and a whitelisted hook that fails `supportsInterface(IACPHook)` must
  revert too (`InvalidHook`).
- A whitelisted hook is the trust boundary. The kernel's reentrancy guard and
  CEI ordering are still tested against a deliberately malicious whitelisted
  hook, because "we audited it" is not a security property.

## Gas limit

The kernel forwards `hookGasLimit` to every hook call
(`call{gas: hookGasLimit}`) and bubbles the revert data. The limit is an
immutable set at deployment (1 000 000 on Arc Testnet) and it is absolute: the
hook receives `min(hookGasLimit, 63/64 of what is left)` whatever gas the
transaction carries, so a hook whose own work does not fit under the limit
fails on every attempt, and no keeper can fix that by sending more gas. A hook
that runs out of gas reverts the action; it never means funds move without the
hook having run. The same limit covers the resolver call in `complete`, which
is why the kernel caps the job description at 256 bytes (#92): the record is
read inside those calls, and an unbounded string would let a client spend the
hook's budget on its own text.

The limit has to fit the most expensive path, which is `complete`:

| Component | Measured / expected |
|---|---|
| Groth16 verification, 8 public signals, BN254 precompiles on Arc | ~250 000 (estimate from #17; the measured figure replaces this when #17 lands) |
| `ClaimMarket.payeeOf` and split arithmetic | < 10 000 |
| `giveFeedback` on the deployed ReputationRegistry (stores value, decimals, two tags, index) | ~110 000 (measured on Arc Testnet by the keeper acceptance test in #25; recorded in [docs/deploy/gas.md](../deploy/gas.md)) |
| `validationResponse` | ~60 000 |
| Hook overhead, events, `try/catch` | < 30 000 |

`hookGasLimit` is an immutable of the kernel set at deployment to **1 000 000**:
roughly twice the sum above, so a compliance module that grows and a registry
that gets more expensive both fit without a redeploy, while a hook that loops
still cannot burn the caller's whole block. The acceptance test in #25 measures
the real `complete` gas with the hook attached and fails if the measured hook
share exceeds half the limit, so the margin cannot silently erode.

## `claimRefund` and the receivable

`claimRefund` is not hookable, by the standard and by us. That has one
consequence #29 has to know: if a job expires after a receivable was sold, the
refund goes to the **client**, not the buyer, because the hook never runs and
the kernel has no reason to route anywhere else. The buyer priced that risk;
the market's `payeeOf` only ever affects `complete`. Nothing routes around
`claimRefund` and nothing should.

## What was considered and rejected

**Four hooks behind a multiplexer that calls them in sequence.** Same gas, same
whitelist entry, but the order between compliance and routing would live in a
list rather than in code, and the compliance module would still need the
routed payee. The unified hook makes the dependency explicit.

**Letting the hook write the payout into the kernel during `beforeAction`.**
It works, but it is precisely the "hook modifies escrow state" pattern the
standard forbids, and it needs a reentrancy exception in the kernel for that
one call. The view resolver needs neither.

**Encoding the split into `reason`.** `reason` is an attestation hash and is
forwarded to the reputation registry as `feedbackHash`. Overloading it would
make the reputation trail lie about what it hashes.

**Writing reputation from the kernel.** Keeps the hook simpler, but ties the
kernel to two upgradeable registries and puts a `try/catch` around a registry
call inside the escrow contract. The standard's own guidance is to do this in
`afterAction`, and it is right.
