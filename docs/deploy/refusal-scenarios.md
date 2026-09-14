# Six scenarios of a compliance-gated release

**Status:** measured for [#28][i28] on Arc Testnet (`5042002`) and on anvil,
by the same script. [On Arc](#on-arc) has the receipts and the cost. Reproduce
with `node contracts/script/refusal-scenarios.mjs`, and set `SCENARIO_RPC_URL`
and `SCENARIO_FUNDER_PRIVATE_KEY` for Arc.

[i27]: https://github.com/wienerlabs/square/issues/27
[i28]: https://github.com/wienerlabs/square/issues/28
[i76]: https://github.com/wienerlabs/square/issues/76
[i100]: https://github.com/wienerlabs/square/issues/100
[i245]: https://github.com/wienerlabs/square/issues/245

## What is being claimed

Phase 4's closing sentence, end to end: an institution commits a spending
policy, an agent does the work, and the payment leaves escrow only when a
zero-knowledge proof shows it fits that policy. That covers six scenarios, and
each one is asserted on chain by what the release did and by the reason the
module gave.

| # | Scenario | What the run does | Asserted |
|---|---|---|---|
| 1 | Compliant payment | builds a proof from the chain's own values, binds it to the job and finalizes | `ReleaseVerified`; the provider is paid the net; the day's counter moves by exactly that |
| 2 | Over the daily cap | releases a first payment, then proves a second that takes the day over its ceiling | the circuit emits `is_compliant = 0` with `daily_limit` alone violated; the verifier still accepts the proof; refused, `is_compliant is 0` |
| 3 | Blocked recipient | proves a payment to an address the policy blocks | `is_compliant = 0` with `blocked_recipient` alone violated; refused, `is_compliant is 0` |
| 4 | Policy replaced, old proof | builds a proof, then the client commits a new policy | `previewRelease` true before the change and false after; refused, `policy commitment` |
| 5 | Outside the time window | the policy allows one hour; the proof claims that hour while the chain is twelve hours away | an honest proof at the chain's time violates `time_window` alone; the lying one is compliant; refused, `timestamp outside window` |
| 6 | Another job's valid proof | binds job X's proof to job Y, then to X, then to a job identical to X | Y refused, `amount`; X released; the identical job refused, `proof already used` |

Scenario 6 is about the statement, not about the job number. What
`ComplianceModule` binds is the payee, the amount, the token, the client, the
policy commitment, the day's counter and the timestamp — there is no `jobId`
among them, and the spent mark is keyed on `keccak256` of the eight signals. So
job Y is refused for `amount`, because it is worth a different amount, and not
for being a different job; and the job identical to X is refused only because X
was finalized first and its statement is already marked. Reverse that order and
the identical job releases on X's proof. The binding is per statement, not per
job, which is what makes a proof reusable across two jobs that agree on all
seven bound values.

## Refused, not reverted

The issue says `complete` reverts in scenarios 2 to 6. It cannot, and the
reason is a decision rather than a gap. [#100][i100] found that a hook able to
revert left the escrow with no exit at all: `complete`, `reject` and
`claimRefund` were all closed, and nothing could recover the money. So the
kernel tolerates a hook failure, and a policy stops a release through the one
channel the kernel honours, the payout split
([hook-failure-modes.md](../decisions/hook-failure-modes.md)).

A refusal here is therefore `providerBps = 0`. The job settles, the provider is
paid nothing, the whole net goes back to the client, and the module emits
`ReleaseRefused(jobId, statement, reason)`. The run asserts all four in every refused
scenario, and it asserts the reason by name. A job refused for the wrong reason
fails the run, which is what the negative controls below rely on.

## How the run is built

- **It deploys everything it touches.** That means a settlement stack with a
  30-second challenge window, a `PolicyRegistry`, the repository's verifier
  compiled with this build's key, and a `ComplianceModule` bound to it. The
  code path is the same on anvil and on Arc. CI builds its proving key with
  random phase-2 entropy, so a verifier from any other build rejects every
  proof this run makes
  ([end-to-end-5042002.md](end-to-end-5042002.md#why-the-run-builds-its-own-verifier)).
- **The ungated baseline is measured first.** One job is finalized before the
  module is installed, so the gate's cost is a difference and not an estimate.
- **Each scenario has its own client.** Each client therefore has its own
  commitment and its own day's counter, and no scenario can pass or fail
  because of another one's spending.
- **Every proof is built from the chain, field by field.** The amount is the
  job's net payout, the counter is what the registry holds, and the timestamp
  is the chain's own, except in scenario 5, whose point is claiming another
  one.
- **The proof is bound to the job, not handed to the crank.** Since
  [#245][i245] the module reads the proof the client wrote with
  `setComplianceProof`, and the bytes a keeper passes to `finalize` decide
  nothing. So each client binds its proof before the job is finalized, which is
  one transaction per proof-carrying finalize. The baseline carries no proof
  and binds nothing.
- **The clock is never moved.** The run waits out the real challenge window,
  on anvil as on Arc.
- **Scenario 2 keeps to one day.** Its two releases have to fall on the same
  UTC day, because the registry's counter resets at midnight. The run does not
  start it within five minutes of midnight; it waits for the new day instead
  of failing because of the clock.
- **Keys.** Every actor except the funder is a key drawn for the run. The
  funder deploys, owns, funds and cranks, and at the end whatever the actors
  hold is swept back to it. Their keys exist only in the process, so a run
  that fails halfway recovers before it exits. Every job still open is
  finalized with no proof once its window closes, which puts its net on an
  actor's ledger: the client's if the module is installed and refuses, the
  provider's if it is not. The same sweep then collects it. Signing happens in
  the process through viem, so a key never appears on a command line.

## On Arc

The same script, pointed at Arc Testnet (`5042002`, client `arc/v1`), with
`0xd7e3C3cA8aeC672e45269bcAE584A93b312bc2Bd` as the funder. **All 46 checks
passed**, the same 46 as on anvil, and the run closed with:

    Six scenarios on chain 5042002 (arc/v1): released when compliant, refused by name in every other case.

### After [#245][i245]: the proof bound to the job

The run on the change that binds the proof, in CI (`six refusal scenarios
(Arc Testnet, funded key)`), with the same funder. **All 46 checks passed.** A
gated release is **864,840 gas, 0.019026 USDC** from the receipt of scenario 1,
which is 22 gwei, and the gate's own share is the 619,639 gas above the ungated
baseline, 0.013632 USDC.

| # | Finalize | Gas | Over the baseline | USDC | Transaction |
|---|---|---|---|---|---|
| 0 | released, no module installed | 245,201 | — | 0.005394 | [`0x112a75f1…`](https://testnet.arcscan.app/tx/0x112a75f18cb359a33576f95b0e48752d6912292a4f08144bd181589634dbe41d) |
| 1 | released, proof verified | 864,840 | +619,639 | 0.019026 | [`0x13d2aa78…`](https://testnet.arcscan.app/tx/0x13d2aa78ffad5bb390763dacee121df015157ebbc187ab8d96191ed3eaa07069) |
| 2 | refused: `is_compliant is 0` (`daily_limit`) | 816,243 | +571,042 | 0.017957 | [`0x7da3e6d8…`](https://testnet.arcscan.app/tx/0x7da3e6d832778cbb035dc2f0a4e49ecf58482d5473b8c916955ee4b7762655bf) |
| 3 | refused: `is_compliant is 0` (`blocked_recipient`) | 816,219 | +571,018 | 0.017956 | [`0x1a2b5047…`](https://testnet.arcscan.app/tx/0x1a2b50475c71af7124816e73299282ccc011fd92292b82f60559c7b5cae70412) |
| 4 | refused: `policy commitment` | 822,761 | +577,560 | 0.018100 | [`0xe2d07df0…`](https://testnet.arcscan.app/tx/0xe2d07df07db3911ecc3fd7bda0bf9aff835ca556e608b706d0c5af45c3e87a58) |
| 5 | refused: `timestamp outside window` | 828,067 | +582,866 | 0.018217 | [`0x0f2306b1…`](https://testnet.arcscan.app/tx/0x0f2306b1d33d0946471ce28977f92fa0d5d3b0621908b8042c1648016e2f6999) |
| 6 | refused: `amount` (job Y, carrying job X's proof) | 822,865 | +577,664 | 0.018103 | [`0x1fe23977…`](https://testnet.arcscan.app/tx/0x1fe239773d110d9cd899cb16d46462d99d99fffe9df275059949345ecfd09d6b) |
| 6 | released (job X, its own proof) | 864,828 | +619,627 | 0.019026 | [`0x7a9efb7e…`](https://testnet.arcscan.app/tx/0x7a9efb7e946b7c6c981b1c4ed9e6dc36c857e57f55734fb5f114487b50dafff1) |
| 6 | refused: `proof already used` (job Z, identical to X) | 794,079 | +548,878 | 0.017469 | [`0xf6752629…`](https://testnet.arcscan.app/tx/0xf67526292f1cd4fde966a1c255d74bdd96ebac2adcfb8e61f3c9f225b6ee91aa) |

Scenario 2's first payment, released before its refusal, is not in the run's
printed output and is not listed. The run as a whole was 106 transactions and
30,971,350 gas, 13,502,868 of it the seven deployments, and it cost the funder
0.692311 USDC, budgets included, after the sweep.

### The cost of a gated release

This subsection and the three after it record the earlier run, before
[#245][i245] moved the proof onto the job; the receipts they cite are that
run's.

**815,728 gas, 0.017946 USDC**, from the receipt of scenario 1 at the 22 gwei
every transaction in the run paid. That replaces the report's ~360–420k gas
estimate. The gate's own share is the 579,909 gas above the ungated
baseline, 0.012757 USDC. USDC figures here
truncate to six decimals, as the ERC-20 view of the balance does.

| # | Finalize | Gas | Over the baseline | USDC | Transaction |
|---|---|---|---|---|---|
| 0 | released, no module installed | 235,819 | — | 0.005188 | [`0x710d17e4…`](https://testnet.arcscan.app/tx/0x710d17e423ed91ac6509dc77cac380ab529441ca7edaffae3fabbeb143e59674) |
| 1 | released, proof verified | 815,728 | +579,909 | 0.017946 | [`0x37537c5b…`](https://testnet.arcscan.app/tx/0x37537c5b0b71cb76f17e9515a0414fc401666a5c87690c3e28e554035f1db6bd) |
| 2 | the first payment of the day, released | 815,752 | +579,933 | 0.017946 | [`0x3f27ceb2…`](https://testnet.arcscan.app/tx/0x3f27ceb2e081971d87c474885c7e53b632c950c62967906596e91a60bc33fc37) |
| 2 | refused: `is_compliant is 0` (`daily_limit`) | 767,143 | +531,324 | 0.016877 | [`0x19551507…`](https://testnet.arcscan.app/tx/0x1955150759b7747464f397cffcd07c75b68824dcbdf93c667597640dc8df2426) |
| 3 | refused: `is_compliant is 0` (`blocked_recipient`) | 767,107 | +531,288 | 0.016876 | [`0x3784f01a…`](https://testnet.arcscan.app/tx/0x3784f01a867cfd5cc9353301ddaf56de3e261eb17fb34f6126b4a6aeea4dbdac) |
| 4 | refused: `policy commitment` | 773,649 | +537,830 | 0.017020 | [`0x888df79e…`](https://testnet.arcscan.app/tx/0x888df79e7f6a3ff5da42ff4353526b1469ff3f026ab687321fb8037fd38ae84e) |
| 5 | refused: `timestamp outside window` | 778,979 | +543,160 | 0.017137 | [`0x6ea73a64…`](https://testnet.arcscan.app/tx/0x6ea73a6439b06dea4f272acb2cc2aae6d97eeadbdf39218c005ad4fa856ebc22) |
| 6 | refused: `amount` (job Y, carrying job X's proof) | 773,789 | +537,970 | 0.017023 | [`0xb63985f5…`](https://testnet.arcscan.app/tx/0xb63985f5f9fe1bf7c324b1f4b3418b70fd67e762b06da2ad6dcf614a2477a3c5) |
| 6 | released (job X, its own proof) | 815,752 | +579,933 | 0.017946 | [`0x9d3a97ff…`](https://testnet.arcscan.app/tx/0x9d3a97ff0a87aab94dec6009f86fd71d3cba407d760f936734fa7d0c741c77d0) |
| 6 | refused: `proof already used` (job Z, identical to X) | 749,803 | +513,984 | 0.016495 | [`0xba745208…`](https://testnet.arcscan.app/tx/0xba74520824ec667e543702cba144bf5b5dc2cb5a1eb0a9470501d335d66d9ca7) |

The Arc figures are not anvil's. The two stacks differ: on Arc the token is
Arc's own USDC and the ERC-8004 registries are the deployed ones, while anvil
deploys mocks of both. This document measures the difference and does not
attribute it further.

### What the run deployed

Every contract the scenarios touched was deployed by this run, and USDC and
the ERC-8004 registries are Arc's own
(`0x3600000000000000000000000000000000000000`, `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
`0x8004B663056A597Dffe9eCcC1965A193B7388713`, `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`).

| Contract | Address | Deployment gas | USDC |
|---|---|---|---|
| SquareJob | [`0xeef7e9a314f9d08c3a863bdcca02c8f753c652bc`](https://testnet.arcscan.app/address/0xeef7e9a314f9d08c3a863bdcca02c8f753c652bc) | 3,695,125 | 0.081292 |
| KeeperEvaluator (30 s challenge window) | [`0xdbe0efc85cb682d3151010d6d341b0b26cc01bf8`](https://testnet.arcscan.app/address/0xdbe0efc85cb682d3151010d6d341b0b26cc01bf8) | 2,310,181 | 0.050823 |
| PolicyRegistry | [`0xa46b5edf34585b207d197ea586a176426561e71a`](https://testnet.arcscan.app/address/0xa46b5edf34585b207d197ea586a176426561e71a) | 908,988 | 0.019997 |
| ClaimMarket | [`0x3028b16a8c1279301a9c1b1aacb357aff6c5f301`](https://testnet.arcscan.app/address/0x3028b16a8c1279301a9c1b1aacb357aff6c5f301) | 1,249,014 | 0.027478 |
| SquareHook | [`0x3fb3d54014272f6b171f64ee83037035fb334f73`](https://testnet.arcscan.app/address/0x3fb3d54014272f6b171f64ee83037035fb334f73) | 2,354,436 | 0.051797 |
| Groth16 verifier, this build's key | [`0xcad3ab1d5249642366889ea1f01e62651c93b437`](https://testnet.arcscan.app/address/0xcad3ab1d5249642366889ea1f01e62651c93b437) | 714,777 | 0.015725 |
| ComplianceModule (600 s tolerance) | [`0x158e2ab380152924af39b194e4d4d8f17e771db4`](https://testnet.arcscan.app/address/0x158e2ab380152924af39b194e4d4d8f17e771db4) | 1,393,032 | 0.030646 |

### The run as a whole

97 transactions and 26,225,269 gas, 12,625,553 of it the seven
deployments, for 0.576956 USDC in fees. The funder went from 20.000000
to 19.412102 USDC, which is 0.587898 USDC. The 0.010942 USDC between the two
figures stayed on chain, and each part of it was read back:

- 0.002200 USDC is on the kernel's ledger for the funder as treasury: the 1%
  platform fee on 0.22 USDC of budgets, not withdrawn.
- 0.008737 USDC is in the eight actors' wallets, 1,092 or 1,093 base units
  each: the gas each one was allowed for its own sweep transfer.
- The last 0.000005 USDC is below the six decimals of the ERC-20 view.

### Checked from the chain, not from the script

The script's own report is not the only evidence. With `cast`, against Arc:

- scenario 1's receipt: status 1, block 61571842, 815,728 gas at 22.000 gwei,
  0.017946 USDC;
- scenario 5's receipt: `ReleaseRefused` from the module, job 7, reason
  `timestamp outside window`;
- `SquareHook.complianceModule()` is the module above, and
  `ComplianceModule.verifier()` is the verifier above.

## The run on anvil

```console
$ anvil --silent &
$ node contracts/script/refusal-scenarios.mjs
chain    31337 (anvil, anvil/v1.5.1)
window   30s challenge, tolerance 600s

0  the hook with no module installed, for the baseline
  ok    the provider is paid the whole net
1  a compliant payment
  ok    the circuit says it is compliant
  ok    the module verifies it
  ok    the provider is paid the net
  ok    the day is charged exactly that
2  a payment that takes the day over its ceiling
  ok    the first payment of the day is released
  ok    the circuit says the second is not compliant
  ok    because of the daily limit, and only that
  ok    and the verifier still accepts the proof
  ok    refused, by name: "is_compliant is 0"
  ok    the provider is paid nothing
  ok    the client gets the whole net back
  ok    and the day is not charged for it
3  a payment to a recipient the policy blocks
  ok    because the recipient is blocked, and only that
  ok    refused, by name: "is_compliant is 0"
  …
4  a proof built against a policy that has since been replaced
  ok    before the change the gate would release it
  ok    the client replaced its policy
  ok    after it, the gate would not
  ok    refused, by name: "policy commitment"
  …
5  a policy that allows 01:00-01:59 UTC, paid at 13:xx UTC
  ok    an honest proof, at the chain's time, is not compliant
  ok    because of the time window, and only that
  ok    a proof claiming an allowed hour is compliant
  ok    refused, by name: "timestamp outside window"
  …
6  a valid proof, presented against a job it was not built for
  ok    the proof is valid for its own job
  ok    refused, by name: "amount"
  ok    the same proof then releases its own job
  ok    refused, by name: "proof already used"
  …
Six scenarios on chain 31337 (anvil/v1.5.1): released when compliant, refused by name in every other case.
```

The full output, every check included, is on the run summary of the CI job.

### Measured on anvil

From the CI run on the change that binds the proof to the job
(`six refusal scenarios (policy → proof → anvil)`, anvil/v1.8.1):

| Finalize | Gas | Over the baseline |
|---|---|---|
| 0 released, no module | 254,656 | — |
| 1 released, proof verified | 857,411 | +602,755 |
| 2 refused, daily ceiling | 808,838 | +554,182 |
| 3 refused, blocked recipient | 808,802 | +554,146 |
| 4 refused, commitment replaced | 815,344 | +560,688 |
| 5 refused, timestamp outside window | 820,626 | +565,970 |
| 6 refused, another job (`amount`) | 815,460 | +560,804 |
| 6 refused, identical job (spent) | 786,674 | +532,018 |

The whole run is 116 transactions and 34,152,237 gas, of which 17,015,717 is
its 11 deployments. Two runs of this version agreed to within a few dozen gas:
scenario 2's refusal was 808,838 in CI and 808,814 locally. Salts, keys and
proofs are drawn per run, and calldata costs follow them.

A gated release is 857,411 gas. Before [#245][i245] it was 808,347, the figure
[#76][i76] measured on a different stack, with an ungated baseline of 245,274.
Both rose, so not all of the difference is the gate; the gate's own share went
from +563,073 to +602,755. Either way a gated release is roughly twice the
~360–420k the report estimated, because the pairing check runs twice: once in
`previewRelease`, where the verdict becomes the split, and once in
`checkRelease`, which writes the counter and the mark
([compliance-gate.md](../design/compliance-gate.md)). A refusal costs nearly as
much as a release, since every refusal the run shows is decided after the
pairing.

## Negative controls

Each binding in `ComplianceModule` was switched off in turn and the run
repeated. The module was then restored, byte for byte (`cmp`), and rebuilt.

| Switched off | Result |
|---|---|
| the policy-commitment binding | exit 1: **scenario 4 only**, 5 checks, from "after it, the gate would not" onward |
| the `block.timestamp` window | exit 1: **scenario 5 only**, 4 checks |
| the spent-statement mark | exit 1: **scenario 6's identical job only**, 1 check. It was still refused, but as `daily_spent_before`, because the counter had moved, and the reason check is what catches that |
| the `is_compliant` binding | exit 1, 5 checks, and it separates scenarios 2 and 3. **Scenario 3 is not refused at all**: no `ReleaseRefused`, the provider is paid 19,700, the client is refunded nothing and the day is charged for it. **Scenario 2 is still refused, but by the wrong mechanism** — `daily ceiling` instead of `is_compliant is 0` — which the reason check catches. So the two scenarios that share a reason are not one test written twice |
| the `amount` binding | exit 1: **scenario 6 only**, 6 checks. Job Y, carrying job X's proof, is released — 19,700 to the provider, nothing back to the client. That marks the statement spent, so X's own release is then refused too and the provider is never paid for it. The identical job stays refused, `proof already used` |

Every other scenario stayed green in every control. So each scenario is pinned
by the mechanism it is named after, not by some other check that happens to
refuse it.

## In CI

- `six refusal scenarios (policy → proof → anvil)` in `circuits.yml`, on every
  pull request. It is hermetic apart from the ptau fetch.
- `six refusal scenarios (Arc Testnet, funded key)` in
  `arc-refusal-scenarios.yml`. It uses the same script pointed at Arc, and it
  runs on pushes to `main`, by hand, and on same-repository pull requests that
  change the script or the workflow, one run at a time. It needs the
  `SCENARIO_FUNDER_PRIVATE_KEY` secret ([ci.md](../ci.md#secrets-and-variables)).

## What this does not show

- **Nothing about assurance.** The key has a real phase 1 and a development
  phase 2; see docs/disclosure/zk-setup-status.md.
- **Nothing about the shared Arc stack.** The run gates a hook it deploys
  itself. The shared hook's compliance slot is still empty, which the README
  says and the app's network page reads live. Installing a module there makes
  every release on that stack need a proof bound to its job. That is a change
  to the deployment, not something a test run should do on the way past.
