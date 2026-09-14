# @squaresdk/core

The integration library for Square settlement on [Arc](https://arc.io): one typed client
over the five contracts, the ABIs they compile to, the spec hash a job commits to, and
the decoding of what the contracts emit. Every other package and service in this
repository settles through it; nothing here talks to anything but the chain.

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { connectSquareClient, hashDeliverable } from "@squaresdk/core";

const transport = http("https://rpc.testnet.arc.io");
const square = await connectSquareClient({
  publicClient: createPublicClient({ chain: arcTestnet, transport }),
  walletClient: createWalletClient({ chain: arcTestnet, transport, account: privateKeyToAccount(key) }),
});

const { jobId } = await square.createJob({
  provider,
  expiredAt: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
  spec: { task: "translate", words: 1200, deadline: "2026-09-30T00:00:00Z" },
});
await square.submit({ jobId, deliverable: hashDeliverable(text), did: "did:aip:eip155:5042002:0x8004…:2" });
```

The addresses come from the deployment record for the chain the clients declare; pass
`deployment` to override, or when the clients carry no chain.

## What is worth knowing

**`connectSquareClient` asks the endpoint which chain it is; `createSquareClient` only
asks the clients.** The constructor compares the deployment to the chain the viem
clients *declare*, and both sides of that come from the caller, so it cannot catch an
RPC URL that points at another chain. `connectSquareClient` runs `eth_chainId` once and
refuses on a mismatch before anything is read; `createSquareClient` does the same lazily,
before the first read or write. Either way the refusal is a `DeploymentChainMismatchError`
whose `source` says which comparison failed: `"endpoint"` for the RPC's answer,
`"declared"` for the clients' own chain. A transport failure on the check is not cached;
the next call retries it.

**A revert names the contract that raised it, whichever one you called.** `SquareJob`
re-raises the hook's revert data as its own, and the hook's errors are the ones a `submit`
caller can trigger. viem decodes a revert by looking its selector up in the ABI it was
handed for the call, so every read and every simulation here carries `SQUARE_ERRORS`, the
custom errors of all Square ABIs, through `withSquareErrors`. It adds **error entries
only**, so no function name from one contract can shadow another's, and the ABI a
simulation approved is the one the write goes out with. `AgentNotOwnedByProvider(7, you)`
comes back by name; before, it was `Unable to decode signature 0x2e0a79a4`.

**`submit` takes a DID.** `submit({ jobId, deliverable, did })` binds the job to the
ERC-8004 agent the `did:aip` identifier names, through the hook. The DID has to be scoped
to the chain and Identity Registry this client settles on (`DidScopeMismatchError`
otherwise), and if `agentId` is passed as well it has to agree with it
(`AgentIdMismatchError`). `agentId` alone works too. With neither, no agent is bound.

**`agentOf(jobId)` answers `null` for "no agent bound", and `0n` for agent 0.** Agent
id 0 is a real agent (on Arc's registry it is the first registration), so the hook's own
`agentOf` reverts with `NoAgentBound` when nothing is bound and `boundAgentOf` answers
both questions; this reads the latter. On a hook deployed before that change only the
old `agentOf` exists and answers 0 for both, and this reads its 0 as `null`, which is
what it meant there and is wrong only for agent 0.

**Every write is simulated first, then checked once mined.** A revert in simulation
throws with the decoded error and nothing is sent. A transaction that passes simulation
and reverts once mined throws `TransactionRevertedError` with the hash and receipt. A
successful write returns `{ hash, receipt, events }`, the events decoded across all five
contracts (`decodeReceipt` does the same for a receipt you already hold).

**A write needs a wallet; a read does not.** Construct with `publicClient` alone for a
read-only client; a write on it throws `WalletRequiredError`.

## The spec hash

A job's description is the commitment to what was ordered. `createJob({ spec })` writes
`specDescription(spec)`, which is `spec:` followed by `specHash(spec)`: `keccak256` of the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical form of the spec, so any
party holding the same JSON recomputes the same hash whatever key order or whitespace
it kept. `specMatchesDescription(spec, description)` is the check; `specHashFromDescription`
pulls the hash out, `undefined` for a description that carries none.

The canonical text has to be JSON a parser can read back to a value that canonicalises
to the same text, or the commitment is to something no one else can reproduce. So a spec
is checked for being JSON data at every depth before it is hashed, and anything else is a
`SpecError` that names the path: `null`, booleans, strings, finite numbers, arrays of
those and plain objects of those are JSON data; a bigint, a function, a symbol, `NaN`,
`Infinity`, an `undefined` inside an array, a cycle, a `Date`, a `Map` or a class instance
are not. A key whose value is `undefined` is dropped, as `JSON.stringify` drops it. Pass
amounts as strings or numbers, dates as ISO strings.

## Deployments

`deploymentFor(chainId)` returns the addresses compiled into this package for a chain it
knows (Arc Testnet `5042002`, and `31337` for a local anvil once `DeployLocal.s.sol` has
run); `deploymentFromJson` reads the same shape from a file, which is how the services
take `SQUARE_DEPLOYMENT_FILE`. The compiled copy and `contracts/deployments/5042002.json`
have to move together on a redeploy, and a test here asserts that they agree; see
[`docs/deploy/README.md`](../../docs/deploy/README.md) for the full list of places an
address lives. `networkFor(chainId)` carries what is not an address: the RPC endpoint,
the explorer, the native currency (USDC with 18 decimals on the native interface, 6 on
the ERC-20 one).

## Also exported

- `decodeSquareLogs(logs, deployment)` and `eventsNamed(events, name)`: the receipt's logs
  as typed events across the five contracts.
- `finalizeReason`, `resolutionHash`, `hashDeliverable`, `Outcome`: the hashes the
  contracts expect as `reason` and `evidence`, built the way `KeeperEvaluator` and
  `Arbitration` build them.
- `encodeSubmitOptParams`, `encodeCompleteOptParams` and their decoders: the `optParams`
  bytes of `submit` (agent id and validation request) and `complete` (provider share and
  compliance proof).
- `agentFromDid`: a `did:aip` v2 identifier as `{ chainId, registry, agentId }`.
- The ABIs, from `@squaresdk/core/abi` as well, generated from the compiled contracts and
  checked in CI to still match them.

## Tests

```bash
npm test              # unit, no network
npm run test:anvil    # the lifecycle against a local anvil with DeployLocal.s.sol on it
npm run lifecycle     # the five settlement paths end to end, written up as a report
```

`test/fork.test.ts` runs the same lifecycle against a fork of Arc Testnet with the real
ERC-8004 registries when `ARC_FORK_RPC_URL` is set. `npm run generate:abi` regenerates the
ABIs from `contracts/out`; CI fails if the checked-in copy differs.
