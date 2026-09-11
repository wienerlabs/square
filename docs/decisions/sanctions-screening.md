# Sanctions screening on the settlement path

**Status:** decided for [#35][i35].

[i27]: https://github.com/wienerlabs/square/issues/27
[i30]: https://github.com/wienerlabs/square/issues/30
[i35]: https://github.com/wienerlabs/square/issues/35
[i100]: https://github.com/wienerlabs/square/issues/100

**This document is not legal advice.** It decides how screening is wired into
settlement. Whether the result satisfies an institution's sanctions
obligations is a question for its counsel.

## The gap

None of the three repositories this one draws on screens anything. Covenant
carried a sanctions denylist that shipped empty and never touched settlement.
Its existence made it look like a control; nothing ever ran it. #35 asks for
screening that actually stops settlement, a written decision on what happens
when the screening service is down, and a test proving that the empty-denylist
case cannot pass as working.

## Four decisions

### 1. The source is TRM Labs' sanctions screening API

Arc's documentation names three compliance vendors: Chainalysis, Elliptic and
TRM Labs ([docs.arc.io/arc/tools/compliance-vendors][arc-vendors]). All three
are off-chain. What decided it was what could be used, today, without a
contract, and verified from here:

| | Chainalysis | Elliptic | TRM Labs |
|---|---|---|---|
| Access | a free sanctions API with an emailed key; the product page asks for a demo | sales only ("Book a demo"); no self-serve path found | a free sanctions API: 100 requests a day with no key, 100,000 with a free key |
| Tried from here | the endpoint returned a Cloudflare challenge | nothing to try without a contract | **worked**: an OFAC-designated address came back `isSanctioned: true`, an address drawn at random came back `false` |
| On-chain option | a free `isSanctioned` oracle, **not deployed on Arc** | none | none |

TRM's API answers exactly the question #35 needs answered: is this address
designated. It matches against OFAC, UK and EU lists, and it matches an address
across chains, which is what an EVM address on Arc needs. It is not risk
scoring or transaction monitoring; that would be a different product and a
contract. The API documentation describes it as a "Proprietary API" and does
not link terms of use; that has to be read before production use.

The screener calls it without a key: one request a second and 100 a day, which
is enough for development and CI and not for production. A free key raises that
to 100,000 a day. TRM's public documentation names the key's security scheme
(`organization_api_key`) but not how the key is sent, and the screener does not
guess. The key path is added when TRM's onboarding says how.

The source sits behind one interface in the screener, so a second provider is
an adapter, not a redesign.

[arc-vendors]: https://docs.arc.io/arc/tools/compliance-vendors

### 2. Screening happens at funding and at release

The kernel calls the hook at six points, and they are not equal
(`SquareJob.sol`). `setProvider`, `setBudget`, `fund` and `submit` call it
strictly, so a revert undoes the action. `complete` and `reject` call it
tolerantly, because [#100][i100] found that a hook able to revert there locked
the escrow with no exit.

| Point | Screened | Result when not cleared | Why here |
|---|---|---|---|
| `fund` | the client and the provider | **revert**: nothing enters escrow | The last moment before money moves into escrow, and a strict call. A revert here locks nothing, because the client still holds its money. |
| release (`resolvePayout`) | the payee | **`providerBps = 0`**: the whole net goes back to the client | The last moment before money leaves. The payee is not necessarily the provider screened at funding: a sold receivable pays its buyer ([#30][i30]), and an address can be designated while a job runs. |

**Not at job creation.** Nothing moves, and the parties are not settled yet:
`setProvider` can name the provider later. Whatever was screened at creation
would have to be screened again at funding anyway.

**Not on `reject` or `claimRefund`.** Both return money to the client, who was
screened when it funded. Refusing a refund cannot redirect the money anywhere;
it could only lock it. A client designated after funding is left to the layer
described in §5.

### 3. The answer reaches the chain as a signed record

A screening result is an off-chain fact, and the chain has to be able to hold
someone to it. `finalize` is permissionless and pays its caller, so an unsigned
"cleared" flag would be set by whoever wanted to be paid. The design follows
[travel-rule.md](../design/travel-rule.md): a registered screener signs, and
the chain recovers the signature.

```solidity
struct Screening {
    address subject;     // the address screened
    bool    sanctioned;  // what the source answered
    uint64  screenedAt;  // when it answered
    bytes32 source;      // which source and API, e.g. "trm-sanctions-v1"
    bytes32 evidence;    // keccak256 of the source's raw response
}
```

It is signed under EIP-712, with a domain that binds the chain id and the
registry's address, so a testnet screening cannot clear a mainnet party. It is
submitted to `ScreeningRegistry`: by the screener service itself, or by anyone
who holds the signature. The registry keeps the latest record per address and
refuses a record older than the one it holds. Otherwise a stale "cleared" that
someone kept back could overwrite a newer "sanctioned". `isCleared(subject)` is
true only for a record that exists, is not sanctioned, and is younger than
`maxAge`.

**The result is also written to the ERC-8004 ValidationRegistry**, as the
issue suggests, as an attestation. ERC-8004's rules decide how
([EIP-8004][eip8004], Validation Registry):

- a request is opened by the owner or operator of an agent;
- only the validator a request names may answer it;
- the registry keeps the latest answer for each request.

On a job with a bound agent that validator is already the hook: the provider
names it when it submits, and the hook answers at release. Since #35 the
answer is the gate's whole verdict on the release. It is the verdict
`resolvePayout` already turned into the split: 100 when every installed check
passed and the payee was paid, 0 when the proof or the payee's screening
refused it. Its `responseHash` commits to the screening record the verdict
read: `keccak256(abi.encode(payee, record))`.

The alternative reading was a second answer under its own tag. In a registry
that keeps only the latest answer, that would have replaced the compliance
answer #27 writes, so this design does not use it.

**The decisions still read ScreeningRegistry, not the ValidationRegistry.**
ERC-8004 cannot answer the questions the gate asks:

- At funding the parties screened are a client and a provider, and no agent is
  bound yet; the binding happens at `submit`.
- A client or a buyer is not an agent at all, so there is no request for
  anyone to answer on their behalf.
- An ERC-8004 answer does not expire, and a screening has to.

So the two registries have different jobs. ScreeningRegistry holds the
screenings the decisions are made from, for every party, at both points. The
ValidationRegistry receives the verdict those screenings produced, for the
job's agent, at release. `test_validation_*` in
`contracts/test/SanctionsScreening.t.sol` asserts the exact call, including
the commitment.

[eip8004]: https://eips.ethereum.org/EIPS/eip-8004

### 4. Fail closed, at both points

With no fresh, clean record, funding is refused and the release pays the
provider nothing. The issue names the cost of fail-closed as lock-up. Neither
point locks:

- **At funding** a revert means the client keeps its USDC. With the screener
  down, no new escrow opens until it is back. For an institution, a payment
  that has not started is the right failure.
- **At release** [#100][i100] guarantees the job settles. A payee that is not
  cleared gets `providerBps = 0`, and the net goes to the client, who was
  screened when it funded.

What fail-closed at release does cost is a provider whose payee screening is
stale when someone finalizes. Honest keepers do not do that. Before every
`finalize` on a hook that screens, `services/keeper` asks the screener to
screen the payee and then reads the registry:

- **Cleared:** it finalizes, and the payee is paid.
- **A fresh record says the payee is designated:** it finalizes as well, and
  the release goes back to the client. Holding the job would only delay the
  client's refund.
- **Neither:** the screener could not be reached, and the record is stale or
  missing. The keeper holds the job and asks again on the next tick. The job
  waits; it is not refused.

`finalize` is still permissionless, though, so someone else can finalize while
the screening is stale and trigger the refusal. That is the same exposure a
missing compliance proof already has under [#27][i27]. It is written here, not
hidden.

The screener stamps each answer with the later of the chain's latest block
time and its own clock less five seconds, because the registry judges
freshness by the chain's clock. A chain that trails the screener's clock by a
second does not refuse a fresh answer as coming from the future, and a chain
that has run ahead of it does not refuse the answer as stale.

`maxAge` is the screening's lifetime. It defaults to one hour and the
registry's owner can change it within bounds. The honest release path
re-screens just before `finalize`, so a short window costs nothing there. What
the window does govern is the gap in which a designation made after a clean
screening goes unseen.

## 5. Arc's own blocklist sits under this

Arc enforces a blocklist at the protocol level. A value transfer to or from a
blocklisted address reverts, and the transaction is included and its gas spent
([EVM differences][arc-evm]). This covers the native interface and the ERC-20
interface alike, because they are one balance.

It overlaps with this design, but it does not replace it:

- It is Arc's list, not the institution's screening. It is not asked before a
  job is funded; it acts when USDC moves.
- `SquareJob` pays by ledger, precisely because USDC has a blocklist
  (storage-and-events.md, "Pull payments"). Crediting a blocklisted party
  succeeds, and its `withdraw` reverts. So Arc's blocklist leaves the money on
  the ledger instead of routing it, which is why the release check routes it
  to the client instead.
- It is the backstop for the paths this design deliberately does not gate: a
  refund credited to a client designated after it funded cannot be withdrawn
  to a blocklisted address.

[arc-evm]: https://docs.arc.io/arc/references/evm-differences

## 6. An empty list cannot pass as working

Covenant's failure had two parts. The list was empty, and nothing noticed. The
design here addresses both:

1. **Empty means nobody is cleared.** A newly installed registry has no
   records, and `isCleared` is false for every address. So installing
   screening without running a screener stops funding instead of waving it
   through. A test asserts this.
2. **The source has to prove it is live, on every request.** Each request the
   screener sends also carries a canary: an address with a published OFAC
   designation, set in configuration. If the source does not flag the canary,
   the screener signs nothing and says why. An empty list, a source that
   answers "not sanctioned" to everything, or an API that has changed shape all
   fail this check, and all fail closed. A test runs the check against the
   real source, and runs it again with a canary the source does not flag.
3. **Every record says what answered.** `source` names the provider and API,
   and `evidence` is the hash of the raw response. An auditor holding the
   response can check the record against it.

## Evidence

| What | Where | Result |
|---|---|---|
| The registry's rules: empty clears nobody, only a registered screener counts, revoking it revokes its records, the domain binds chain and registry, an older record cannot overwrite a newer one, records age out at `maxAge` | `contracts/test/ScreeningRegistry.t.sol` | 17 tests |
| The hook on both points, through the real kernel and keeper: an empty registry stops funding; a designated client or provider stops funding; a payee designated during the job is not paid, and the job settles; a sold receivable screens its buyer; refunds are not screened; a registry that reverts is a refusal, not a lock | `contracts/test/SanctionsScreening.t.sol` | 16 tests, three of them asserting the exact ERC-8004 `validationResponse` call: 100 or 0, and the commitment to the screening record |
| The screener: malformed requests are refused before the source is asked, its EIP-712 digest equals the contract's `digestOf`, the registry records what it signs and refuses a key it does not know | `services/screener/test` | 11 tests (8 hermetic, 3 on anvil) |
| TRM itself: an SDN-listed address is flagged, an unused one is not; with a canary TRM does not flag, nothing is signed | `services/screener/test/live.test.ts` | 2 tests, real requests |
| The keeper holds an unscreened payee, finalizes a cleared one, and lets a designated one be refused | `services/keeper/test/screening.test.ts` | on anvil |
| End to end: the real screener process, TRM's answers and the real hook. An SDN-listed provider cannot be funded (`NotCleared` naming it), an SDN-listed buyer is not paid (its record reads sanctioned), the honest release is paid, and a screener with a canary TRM does not flag records nothing | `contracts/script/screening-on-anvil.mjs` | 26 checks, including the ERC-8004 record reading 0 for the refused release and 100 for the paid one |
| What a release-time screening costs in time, with the real screener against a real chain; every answer read back from the chain | `contracts/script/screening-latency.mjs` | 3 rounds on Arc Testnet, 3 on anvil (§ Latency) |

The SDN-listed addresses are three of OFAC's Lazarus Group designations, from
the Ronin bridge theft. No test assumes they are still listed: each one asks
TRM, and fails if TRM stops flagging them.

## Latency

The issue names the cost of screening at release: the last check before money
leaves adds latency. It was measured with the real screener service against a
real chain, using `contracts/script/screening-latency.mjs`. One request is TRM's
answer followed by one `submitMany` waited on until its receipt.

| Chain, 3 rounds each | TRM's answer | Submission to receipt | Round trip |
|---|---|---|---|
| Arc Testnet | 441–667 ms | 806–1,293 ms | 1,339–1,871 ms |
| anvil | 455–685 ms | 15–27 ms | 476–725 ms |

On Arc, a screened release therefore waits about one and a half to two seconds
longer than an unscreened one: TRM's answer plus one confirmation. The keeper
spends that time before `finalize`, not inside it, so a slow screening delays a
release and never breaks one.

The first Arc run also turned up a cost that was not the check's own. viem
polls for a receipt every four seconds when the chain declares no block time,
and one round in three waited 4,561 ms for a confirmation Arc had already made.
The other two rounds took 523 and 547 ms. The screener now polls every 250 ms
(`RECEIPT_POLL_MS`), and the table above is the run after that change. On
anvil the two settings measure the same, because the receipt is there on the
first read.

TRM's keyless tier allows one request a second; with a key it allows 1,000.

| Arc run | Registry | Submissions |
|---|---|---|
| after the change | [`0x20eae910…`](https://testnet.arcscan.app/address/0x20eae910c7212d5d1bda20bdcf9c3652b4732530) | [1](https://testnet.arcscan.app/tx/0xdadf048d00f188715c76c59480def233a5dcf62e30b060edfacff8fc06abdd04) · [2](https://testnet.arcscan.app/tx/0xd9efc7ef304eb3291ed5531047ab5f8627af1afd673c2749f0718a82ba1910e4) · [3](https://testnet.arcscan.app/tx/0x11d3415fd8c3b579c6aa7d9d7810ec6189c639189440f5d06570b9b1e917a48e) |
| before it, 4 s polling | [`0x65fb0868…`](https://testnet.arcscan.app/address/0x65fb086885e773bafed86acb4a81c2393b1101ed) | [1](https://testnet.arcscan.app/tx/0xe4d1aa25e8b6e77f2f933d939e1748706485233808640cb1eeea62a0ed89dd18) · [2](https://testnet.arcscan.app/tx/0x65d57335a059b318493bedfe55742a07130958db488f99ab7241e78c5a659d7c) · [3](https://testnet.arcscan.app/tx/0xa33ba480b4fce60b6da8191c39cf2695b0a3fa27f4f4957ae6e48c03494b3d6c) |

## What this does not do

- **It is not transaction monitoring.** It answers whether an address is
  designated, not what the address has touched.
- **It does not screen refunds** (§2), and it does not replace Arc's blocklist
  (§5).
- **It is not installed by default on a development chain**, for the same
  reason the compliance module is not (compliance-gate.md). Once installed,
  every funding needs screened parties, and nothing on a local chain produces
  screenings unless the screener runs.
- **It is not installed in the shared Arc stack.** The hook deployed there
  predates this code, and redeploying the stack needs the owner's key. The
  screener and a ScreeningRegistry have run on Arc, in the latency
  measurement above. `DeployLocal` deploys a registry, and
  `INSTALL_SCREENING=true` installs it in the hook.
