# Storage layout and event schema

**Status:** design, decided in [#6][i6]. Binds the settlement core in [#20][i20],
the keeper evaluator in [#21][i21], arbitration in [#22][i22], reputation in
[#23][i23], the indexer in [#24][i24] and the claim market in [#29][i29]. The hook
half of the design is in [square-hook.md](./square-hook.md) ([#53][i53]).

[i6]: https://github.com/wienerlabs/square/issues/6
[i20]: https://github.com/wienerlabs/square/issues/20
[i21]: https://github.com/wienerlabs/square/issues/21
[i22]: https://github.com/wienerlabs/square/issues/22
[i23]: https://github.com/wienerlabs/square/issues/23
[i24]: https://github.com/wienerlabs/square/issues/24
[i29]: https://github.com/wienerlabs/square/issues/29
[i53]: https://github.com/wienerlabs/square/issues/53

The five Solana programs this replaces had no events at all; discovery ran on
`getProgramAccounts` with memcmp filters. On Arc that mechanism does not exist,
so the escrow is discovered through logs and an indexer. The rule this document
enforces: **every state transition emits enough for an indexer to rebuild the
state without a second call to the chain.** If the indexer in #24 ever has to
`eth_call` to fill a gap, this schema is wrong and the fix lands here, not there.

Storage and events are designed together so that neither has to change when the
other is implemented. The two questions #6 was asked answer as follows.

| Question | Decision |
|---|---|
| USDC unit | ERC-20 base units, 6 decimals, everywhere. Nothing in storage or in an event can be read as wei. [Decided in #14.](../decisions/erc20-vs-native-usdc.md) |
| `uint64` or wider for amounts | **`uint64` in storage.** The circuit's ceiling is 2^64 base units; packing the escrow amount into `uint64` makes the two limits coincide, so an amount that fits storage always fits the proof and the contract never has to reject "≥ 2^64" separately. `setBudget` reverts with `BudgetTooLarge` above `type(uint64).max`; the ERC-8183 ABI still takes `uint256`. |

## Contracts

| Contract | Role | Holds USDC |
|---|---|---|
| `SquareJob` | ERC-8183 kernel: job lifecycle, escrow, fee snapshot, pull-payment ledger, hook whitelist | yes: every escrowed budget and every unclaimed payout |
| `KeeperEvaluator` | the evaluator seat for every optimistic job: challenge window, permissionless finalize, keeper fee forwarding, dispute entry | transiently, one evaluator fee at a time |
| `Arbitration` | bonded disputes, versioned arbiter set, M-of-N vote by bitmask, decision record | yes: dispute bonds until the dispute closes |
| `ClaimMarket` | receivable listing, purchase, cancellation, payee lookup | no: price moves buyer → seller directly |
| `SquareHook` | the single whitelisted `IACPHook`: payout routing, compliance slot, reputation and validation writes | no |
| `PolicyRegistry` | the policy commitment and the daily spend counter the compliance module reads and moves | no |

`SquareJob` never reads a live token balance. Every transfer out is computed
from the stored `budget` and the fee basis points snapshotted at funding.

## SquareJob storage

### Job record

Six fixed slots plus a dynamic string. Amounts are 6-decimal USDC base units,
timestamps are seconds, basis points are out of 10 000.

```
slot 0  client        address  20   creator; receives refunds
        createdAt     uint48    6   block.timestamp at createJob
        expiredAt     uint48    6   client-chosen deadline; claimRefund opens here
slot 1  provider      address  20   may be zero until setProvider
        fundedAt      uint48    6   0 until Funded
        submittedAt   uint48    6   0 until Submitted; the challenge window counts from here
slot 2  evaluator     address  20   never zero (ERC-8183 "SHALL revert if evaluator is zero")
        budget        uint64    8   escrowed amount, 6 decimals; the circuit ceiling
        status        uint8     1   JobStatus
slot 3  hook          address  20   zero = no hook; must be whitelisted at creation
        platformFeeBP uint16    2   snapshot taken at fund
        evaluatorFeeBP uint16   2   snapshot taken at fund
        providerBps   uint16    2   share of the net that went provider-side at complete
slot 4  payee         address  20   who received the provider-side share at complete
slot 5  deliverable   bytes32  32   set at submit
slot 6+ description   string        set at creation; kept because ERC-8183 tooling reads it through getJob
```

`JobStatus` is ERC-8183's enum in ERC-8183's order: `Open, Funded, Submitted,
Completed, Rejected, Expired`. A dispute does **not** change `status`; while a
dispute is open the job stays `Submitted` and the evaluator simply does not call
`complete`. Dispute state lives in `KeeperEvaluator` and `Arbitration`.

Why the fee snapshot: `platformFeeBP` and `evaluatorFeeBP` are contract-wide
admin values. If they were read at `complete`, an admin change between funding
and completion would change what the provider is paid and what a receivable is
worth. Snapshotting at `fund` fixes the net payout at the moment money enters
escrow, which is what the claim market prices and what the compliance proof
binds to.

### Contract-wide

```
jobCounter          uint256                      last id issued; ids start at 1
jobs                mapping(uint256 => Job)
whitelistedHooks    mapping(address => bool)     address(0) is an entry, initially true
withdrawable        mapping(address => uint256)  pull-payment ledger
totalWithdrawable   uint256                      sum of the ledger, for the solvency invariant
platformFeeBP       uint16
evaluatorFeeBP      uint16
platformTreasury    address
paymentToken        IERC20 (immutable)           USDC at 0x3600…0000 on Arc
hookGasLimit        uint256 (immutable)          gas forwarded to each hook call
```

Solvency invariant, checked by the test suite after every operation:

```
paymentToken.balanceOf(SquareJob) >= Σ budget[status ∈ {Funded, Submitted}] + totalWithdrawable
```

### Pull payments

Nothing is pushed. `complete`, `reject` and `claimRefund` credit `withdrawable`
and the recipient calls `withdraw()` or `withdrawTo(to, amount)`. This is a
deliberate departure from the reference implementation's push, for a reason
specific to a USDC-native chain: the USDC contract has a blocklist, and a push
to a blocklisted recipient reverts. With push, one blocklisted provider makes
`complete` revert forever and the client's only exit is `claimRefund` after
expiry. With a ledger, crediting cannot fail, and the recipient chooses where to
withdraw to.

The normative ERC-8183 events fire at the credit, not at the transfer, because
the credit is the settlement decision. `Withdrawn` records the transfer.

### Payout routing

At `complete` the net amount (`budget − platformFee − evaluatorFee`) is split:

```
providerShare = net × providerBps / 10 000   → credited to payee
clientShare   = net − providerShare          → credited to client
```

`payee` and `providerBps` come from the hook through `IPayoutResolver` (see
[square-hook.md](./square-hook.md)). Without a hook, or with a hook that does
not implement the resolver, `payee = provider` and `providerBps = 10 000`. The
kernel validates both: `payee != 0`, `providerBps <= 10 000`. The hook cannot
create or destroy value; it can only say who receives the provider-side share
and how large it is. This is how a sold receivable pays its buyer (#29) and how
an arbitration split is expressed (#22) without a third terminal state, which
ERC-8183 does not have.

## KeeperEvaluator storage

```
squareJob      immutable
arbitration    address     set once by the owner
windows[]      {effectiveFrom uint48, challengeWindow uint48, disputeWindow uint48}
disputes       mapping(uint256 jobId => {disputer address, disputedAt uint48, resolved bool})
```

Windows are versioned by time rather than overwritten: a job uses the entry in
force at its `submittedAt`. An owner cannot shorten the window of a job that is
already in it.

## Arbitration storage

```
keeperEvaluator  immutable
paymentToken     immutable
sets             mapping(uint32 version => {arbiters address[], threshold uint8})
index            mapping(uint32 version => mapping(address => uint8))   1-based, 0 = not an arbiter
currentVersion   uint32
bondBps          uint16       default 1000 (10 %)
minBond          uint64       default 1_000_000 (1 USDC)
disputes         mapping(uint256 jobId => Dispute)
withdrawable     mapping(address => uint256)   bond payouts are pull, same reason as above

Dispute
  disputer       address
  bond           uint64
  disputedAt     uint48
  setVersion     uint32     arbiter set the dispute was opened under
  voted          uint256    bitmask: arbiters (by index in setVersion) who have voted, any resolution
  decided        bool
  outcome        uint8      0 none, 1 Complete, 2 Reject
  providerBps    uint16     meaningful when outcome = Complete
  closed         bool
approvals        mapping(uint256 jobId => mapping(bytes32 resolutionHash => uint256 bitmask))
```

A vote is recorded against `resolutionHash = keccak256(abi.encode(jobId,
outcome, providerBps))`. The first resolution whose bitmask reaches
`threshold` decides. An arbiter votes at most once per dispute (`voted`), so the
same address cannot approve two competing resolutions. Rotating the arbiter
set increments `currentVersion`; disputes already open keep voting under the
version they were opened with, so a rotation neither freezes nor re-indexes
them.

## ClaimMarket storage

```
squareJob        immutable
keeperEvaluator  immutable
paymentToken     immutable
listings         mapping(uint256 jobId => Listing)

Listing
  seller     address    the job's provider at listing time
  buyer      address    zero until sold
  price      uint64
  faceValue  uint64     SquareJob.netPayout(jobId) at listing time
  status     uint8      0 none, 1 Listed, 2 Sold, 3 Cancelled
```

One listing per job. A cancelled listing may be replaced; a sold one is final.
`payeeOf(jobId)` returns `buyer` when `status == Sold`, else the provider.

## SquareHook storage

```
squareJob, claimMarket, identityRegistry, reputationRegistry, validationRegistry   immutable
complianceModule   address                       zero until #27 plugs in
agentOf            mapping(uint256 jobId => uint256 agentId)         bound at submit
validationOf       mapping(uint256 jobId => bytes32 requestHash)     bound at submit
recorded           mapping(uint256 jobId => bool)                    reputation written once
```

## PolicyRegistry storage

Not part of the job lifecycle: it is keyed by the institution, not by `jobId`, so
nothing here appears in a per-job filter.

```
policies    mapping(address poster => Policy)
              commitment  bytes32     the circuit's policy_data_hash; zero means no policy
              dailyLimit  uint128     public ceiling, USDC base units, bounded by uint64 max
              updatedAt   uint64      when the commitment last changed
              epoch       uint64      +1 on every setPolicy; what a proof binds to
spend       mapping(address poster => DailySpend)
              day         uint64      UTC day index, timestamp / 86400
              spent       uint128     recorded against that day; stale days read as zero
spenders    mapping(address spender => bool)   who may move a counter — #27's module
```

`Policy` is two slots (`bytes32`, then `uint128 + uint64 + uint64`) and
`DailySpend` is one (`uint64 + uint128`), so a second release in the same day is
a single warm `SSTORE`.

The reset is lazy: a stored `day` that is not today reads as zero and nothing has
to run at midnight. It is a calendar day, not a rolling window — see
[public-daily-ceiling.md](../decisions/public-daily-ceiling.md).

## Events

Most events carry `jobId` as their first indexed topic, so one filter per contract
returns most of a job's history. The exceptions are listed here rather than left
for a reader to find, because two of them move money.

**Two account-keyed money events a `jobId` filter cannot see:**

| Event | Contract | Keyed by |
|---|---|---|
| `Withdrawn(address indexed account, address indexed to, uint256 amount)` | `SquareJob` | `account` |
| `BondWithdrawn(address indexed account, address indexed to, uint256 amount)` | `Arbitration` | `account` |

The pull-payment ledger and the dispute-bond ledger are keyed by the account
being paid, not by the job the money came from, and neither event carries a
`jobId` at all. So the moment a job's money leaves the contract is absent from
that job's filter: an indexer built on `jobId` alone sees every credit and no
debit. The reference reducer takes both through the account rather than the job
(`services/indexer/src/reducer.ts`), and anything else reading these logs has to
do the same.

**Configuration and administration, which have no job to name:** `FeesUpdated`
and `HookWhitelistUpdated` on `SquareJob`; `ArbitrationSet`,
`WindowsConfigured` and `FinalizeGraceConfigured` on `KeeperEvaluator`;
`ArbitersUpdated` and `BondParametersUpdated` on `Arbitration`;
`ComplianceModuleUpdated` and `ReputationPolicyUpdated` on `SquareHook`; and the
`Ownable2Step` pair below, which five of the six contracts inherit.
`PolicyRegistry` is a case of its own, in its section further down: it is keyed
by the institution throughout and has no `jobId` anywhere.

Every event any of the six contracts declares appears in the tables below, and
`packages/core/scripts/check-events-documented.mjs` fails the `contracts`
workflow when one does not.

### SquareJob, normative (ERC-8183)

Signatures match the reference implementation byte for byte, so anything that
already indexes an ERC-8183 kernel indexes ours.

| Event | Emitted by | Meaning |
|---|---|---|
| `JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)` | `createJob` | Open |
| `ProviderSet(uint256 indexed jobId, address indexed provider)` | `setProvider` | provider filled in |
| `BudgetSet(uint256 indexed jobId, uint256 amount)` | `setBudget` | price agreed |
| `JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)` | `fund` | Funded |
| `JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)` | `submit` | Submitted |
| `JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)` | `complete` | Completed |
| `JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)` | `reject` | Rejected |
| `JobExpired(uint256 indexed jobId)` | `claimRefund` | Expired |
| `PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)` | `complete` | provider-side share credited; `provider` is the payee, which is the buyer when a receivable was sold |
| `EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount)` | `complete` | evaluator fee credited |
| `Refunded(uint256 indexed jobId, address indexed client, uint256 amount)` | `complete` (client share of a split), `reject`, `claimRefund` | client credited |
| `HookWhitelistUpdated(address indexed hook, bool status)` | admin | |

### SquareJob, Square extensions

What the normative set does not carry and the indexer needs.

| Event | Emitted by | Carries |
|---|---|---|
| `JobDescribed(uint256 indexed jobId, uint48 createdAt, string description)` | `createJob` | the description and creation time; `JobCreated` is not widened so its topic stays standard |
| `FeesSnapshotted(uint256 indexed jobId, uint16 platformFeeBP, uint16 evaluatorFeeBP, uint48 fundedAt)` | `fund` | the fee basis points the payout will use |
| `SubmissionTimed(uint256 indexed jobId, uint48 submittedAt, uint48 expiredAt)` | `submit` | the timestamp the challenge window counts from, so the indexer does not fetch the block header |
| `PayoutRouted(uint256 indexed jobId, address indexed payee, uint16 providerBps, uint256 providerShare, uint256 clientShare)` | `complete` | the routing decision |
| `PlatformFeeAccrued(uint256 indexed jobId, address indexed treasury, uint256 amount)` | `complete` | |
| `Withdrawn(address indexed account, address indexed to, uint256 amount)` | `withdraw`, `withdrawTo` | ledger debit; keyed by account, not by job |
| `FeesUpdated(uint16 platformFeeBP, uint16 evaluatorFeeBP, address treasury)` | admin | |
| `HookFailed(uint256 indexed jobId, address indexed hook, bytes4 selector, bytes reason)` | `complete`, `reject` | a hook call the kernel makes tolerantly reverted and settlement went ahead regardless. `selector` is the kernel function that was running, `reason` the revert data. A hook that fails on the settlement path is a signal, never a stuck job |
| `PayoutUnresolvable(uint256 indexed jobId, address indexed hook)` | `claimRefund` | the job was Submitted and its hook resolves the payout, but the hook can no longer answer with a usable payee. Expiry proceeds and the client is refunded; without this branch the escrow would have no way out |

### KeeperEvaluator

| Event | Carries |
|---|---|
| `WindowsConfigured(uint48 effectiveFrom, uint48 challengeWindow, uint48 disputeWindow)` | a new window entry |
| `FinalizeGraceConfigured(uint48 finalizeGrace)` | the grace period belonging to the window entry `WindowsConfigured` just announced. Both are emitted together on every window push, from the constructor, `configureWindows` and `setFinalizeGrace`; two events because the grace was added after the standard triple and widening the first one would have moved its topic |
| `ArbitrationSet(address indexed arbitration)` | which `Arbitration` contract this evaluator trusts. `setArbitration` refuses the zero address and refuses to run twice, so this fires exactly once in the contract's life and is the only record of the binding |
| `Finalized(uint256 indexed jobId, address indexed keeper, uint256 keeperFee)` | optimistic completion, and who was paid for calling it |
| `DisputeRaised(uint256 indexed jobId, address indexed disputer, uint48 disputedAt, uint48 challengeEnd)` | the window closes for finalize |
| `DecisionApplied(uint256 indexed jobId, uint8 outcome, uint16 providerBps, address indexed keeper, uint256 keeperFee)` | an arbitration decision settled on the kernel |

### Arbitration

| Event | Carries |
|---|---|
| `ArbitersUpdated(uint32 indexed version, address[] arbiters, uint8 threshold)` | full set, so the indexer can map bitmask bits to addresses |
| `BondParametersUpdated(uint16 bondBps, uint64 minBond)` | |
| `DisputeOpened(uint256 indexed jobId, address indexed disputer, uint64 bond, uint48 disputedAt, uint32 setVersion, uint48 resolveBy)` | |
| `VoteCast(uint256 indexed jobId, address indexed arbiter, bytes32 indexed resolutionHash, uint8 outcome, uint16 providerBps, uint256 approvals)` | running bitmask for that resolution |
| `DecisionReached(uint256 indexed jobId, uint8 outcome, uint16 providerBps, bytes32 resolutionHash)` | threshold met |
| `DisputeExpired(uint256 indexed jobId)` | no decision by `resolveBy`; degrades to the optimistic outcome |
| `BondSettled(uint256 indexed jobId, address indexed to, uint64 amount)` | bond credited to whoever won it |
| `BondWithdrawn(address indexed account, address indexed to, uint256 amount)` | bond ledger debit; keyed by account, not by job |

### ClaimMarket

| Event | Carries |
|---|---|
| `ClaimListed(uint256 indexed jobId, address indexed seller, uint64 price, uint64 faceValue)` | |
| `ClaimBought(uint256 indexed jobId, address indexed buyer, address indexed seller, uint64 price)` | payee changes to `buyer` |
| `ClaimCancelled(uint256 indexed jobId, address indexed seller)` | |

### SquareHook

| Event | Carries |
|---|---|
| `AgentBound(uint256 indexed jobId, uint256 indexed agentId, bytes32 validationRequestHash)` | at submit |
| `ComplianceChecked(uint256 indexed jobId, address indexed payee, uint256 amount, bool verified)` | at complete; `verified` is false while no module is installed |
| `ReputationRecorded(uint256 indexed jobId, uint256 indexed agentId, uint8 outcome, int128 value)` | |
| `ReputationWriteFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason)` | the registry reverted; settlement was not rolled back |
| `ValidationRecorded(uint256 indexed jobId, bytes32 indexed requestHash, uint8 response)` | |
| `ValidationWriteFailed(uint256 indexed jobId, bytes32 indexed requestHash, bytes reason)` | |
| `ComplianceCheckFailed(uint256 indexed jobId, bytes reason)` | the installed compliance module reverted while `beforeAction` was checking the release. The revert data is carried, the `ComplianceChecked` that follows reports `verified = false`, and settlement continues |
| `ReleaseUnconfirmed(uint256 indexed jobId, address indexed payee, uint256 amount)` | at complete, from `afterAction`: the kernel paid `amount` to `payee` on a compliance preview that passed, and the check that books the release, the counter and the replay mark, did not pass. It should never fire (#225); the indexer counts it into `square_hook_write_failures_total{kind="complianceCheck"}` and the `hookWriteFailures` alert fires on it |
| `ReputationSkipped(uint256 indexed jobId, uint256 indexed agentId, bytes32 reason)` | positive feedback that was deliberately not written, with `reason` either `untrusted evaluator` or `budget below minimum`. No registry call was attempted, so this is neither `ReputationRecorded` nor `ReputationWriteFailed` |
| `ComplianceModuleUpdated(address indexed module)` | |
| `ReputationPolicyUpdated(address indexed trustedEvaluator, uint64 minReputationBudget)` | the constructor and every later policy change: whose jobs earn positive reputation, and the budget below which it is not written |

### PolicyRegistry

Keyed by `poster` rather than `jobId`. An indexer reconstructing an
institution's compliance state filters on the poster address.

| Event | Carries |
|---|---|
| `PolicyCommitted(address indexed poster, bytes32 indexed commitment, uint128 dailyLimit, uint64 epoch)` | on every `setPolicy`, including a replacement; `epoch` is what distinguishes them |
| `SpendRecorded(address indexed poster, uint64 indexed day, uint256 amount, uint256 spentAfter)` | on every release, accepted or not; `day` is the UTC day index |
| `ReleaseOutsidePolicy(address indexed poster, uint64 indexed day, uint256 spentAfter, uint128 dailyLimit, Verdict verdict)` | beside `SpendRecorded` when the verdict is not `Compliant`, with `verdict` either `NoPolicy` or `LimitExceeded`. The release still happened; this is the record that it happened outside the ceiling |
| `SpenderUpdated(address indexed spender, bool allowed)` | owner only |

A release outside the policy is not refused, it is recorded. `recordSpend` never
reverts on policy grounds: it advances the counter, returns a `Verdict` and
emits `ReleaseOutsidePolicy` alongside `SpendRecorded`. The counter may then
stand above the ceiling, which is the truthful reading because the money left.
`SquareHook._checkRelease` wraps the module in `try/catch`, so a revert here
would have been swallowed and the counter's own advance lost with it. Compliance
is a signal on the release, never a lock on the escrow
([hook-failure-modes.md](../decisions/hook-failure-modes.md)).

### Ownership, on every owned contract

`SquareJob`, `KeeperEvaluator`, `Arbitration`, `SquareHook` and `PolicyRegistry`
inherit OpenZeppelin's `Ownable2Step`, so each of them declares the same pair.
`ClaimMarket` has no owner and declares neither.

| Event | Carries |
|---|---|
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` | `transferOwnership` nominated a new owner; nothing has changed yet |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | the nominee called `acceptOwnership`, or the constructor set the first owner. This is the transfer |

An event that should never fire needs a consumer in the change that adds it.
`HookFailed`, `ReputationWriteFailed`, `ValidationWriteFailed`,
`ReleaseUnconfirmed` and `PayoutUnresolvable` all mean "the design tolerated
something it did not want",
and a tolerated failure nobody reads is an unobserved one. So the same change
that adds such an event adds the reader: a reducer branch, a metric or a mirror
column, and where it warrants attention an alert rule. A pull request that adds
one without a consumer is incomplete, whatever the event records.

## When the ERC-8004 registries are written

| Moment | Registry | Call | Who is credited |
|---|---|---|---|
| `submit` with `optParams = abi.encode(agentId, validationRequestHash)` | none written; the hook checks `IdentityRegistry.ownerOf(agentId) == provider` (or `getAgentWallet(agentId) == provider`) and binds the job to the agent | | |
| `complete`, in `afterAction` | `ReputationRegistry.giveFeedback(agentId, +1, 0, "square", "completed", "", "", reason)` | the job's **provider** agent, never the payee. A sold receivable moves the money, not the credit (#23, #29) |
| `complete`, in `afterAction`, when the compliance module verified a proof | `ValidationRegistry.validationResponse(requestHash, 100, "", 0, "square.compliance")` | the agent that opened the request |
| `reject` from Submitted, in `afterAction` | `giveFeedback(agentId, -1, …, "rejected")` and `validationResponse(requestHash, 0, …)` | provider agent |
| `reject` from Open or Funded | nothing; no work was delivered, no signal is warranted | |
| `claimRefund` (Expired) | not hookable, so nothing at the moment of expiry. `SquareHook.recordExpiry(jobId)` is permissionless, checks `status == Expired` on the kernel, and writes `giveFeedback(agentId, 0, …, "expired")` once. The keeper (#42) calls it. | provider agent |

Registry writes are wrapped in `try/catch`. A registry that reverts emits
`ReputationWriteFailed` / `ValidationWriteFailed` and settlement proceeds; a
reputation side effect must never lock money in escrow.

## Rebuilding state from events only

The indexer's reducer, per job, in log order. Each row is the *only* input it
needs; nothing is read from the chain.

| Event | Reducer |
|---|---|
| `JobCreated` + `JobDescribed` | insert row: Open, client, provider (may be zero), evaluator, expiredAt, hook, description, createdAt |
| `ProviderSet` | provider |
| `BudgetSet` | budget |
| `JobFunded` + `FeesSnapshotted` | Funded, budget (authoritative), fee snapshot, fundedAt; `net = budget − fees` |
| `JobSubmitted` + `SubmissionTimed` | Submitted, deliverable, submittedAt; `challengeEnd = submittedAt + window in force` (from `WindowsConfigured` history) |
| `DisputeRaised` / `DisputeOpened` | disputed; finalize blocked; `resolveBy` |
| `VoteCast` | approvals per resolution |
| `DecisionReached` / `DisputeExpired` | decided outcome |
| `PayoutRouted` + `PaymentReleased` + `Refunded` + `EvaluatorFeePaid` + `PlatformFeeAccrued` + `JobCompleted` | Completed, payee, providerBps, ledger credits |
| `JobRejected` + `Refunded` | Rejected, ledger credit to client |
| `JobExpired` + `Refunded` | Expired, ledger credit to client |
| `Withdrawn` | ledger debit |
| `ClaimListed` / `ClaimBought` / `ClaimCancelled` | listing state; payee for the query surface |
| `BondSettled` / `BondWithdrawn` | bond ledger |

The three query surfaces #24 asks for fall out of the row: open jobs are
`status ∈ {Open, Funded}`; an agent's jobs are `provider = ?`; escrows in the
challenge window are `status = Submitted AND NOT disputed AND now < challengeEnd`.

The proof that this is sufficient is a test, not an argument: #24's differential
test drives every path on a local chain, rebuilds from logs, and compares the
result field by field against `getJob`, `withdrawable`, `disputes` and
`listings` read from the chain. A mismatch is a bug in this schema.

## What was considered and rejected

**Widening `JobCreated` to carry the description.** It would save one event per
job but change the topic hash of the one event every ERC-8183 indexer filters
on. A second event is cheaper than being invisible to the ecosystem.

**A `Disputed` status.** ERC-8183 has six statuses and no room for a seventh
without breaking `getJob` for standard tooling. A dispute is the evaluator
declining to act, which the standard already allows; the fact of the dispute is
an event on the evaluator, where it belongs.

**Storing `reason` on the job.** Every reader that wants it has the event, and
the hook forwards it to the reputation registry as `feedbackHash`. A storage
slot for something no contract path reads back is gas spent for nothing.

**`uint256` amounts with an explicit `< 2^64` check.** Works, but it puts the
circuit's ceiling in two places. Packing into `uint64` puts it in one and saves
a slot.
