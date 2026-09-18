# Deploying and redeploying the settlement stack

Three redeploys in three days (2026-09-07, 2026-09-08, 2026-09-09) taught the
same lesson each time: the addresses live in more than one place, and several
documents quote numbers measured on whichever stack was current when they were
written. This page is the checklist a redeploy walks, so that nothing goes
stale silently. The runbook for the deploy itself is in
[contracts/README.md](../../contracts/README.md).

## 1. Before the deploy

- Read `git log -- contracts/src` since the last deploy record and list what
  changed on chain; that list becomes the "What changed on chain" table of the
  new record.
- Decide the parameters (`contracts/script/deploy-arc-testnet.sh` carries the
  testnet defaults) and check the deployer balance covers about 0.3 USDC of gas.

## 2. Addresses: the two sources and their readers

The addresses are written in two places and read by different consumers, so
both have to move together (#168):

| Source | Written by | Read by |
|---|---|---|
| `contracts/deployments/5042002.json` | the deploy script | the services when `SQUARE_DEPLOYMENT_FILE` is set, the lifecycle runner, the tests |
| `packages/core/src/deployments.ts` | by hand after the deploy | the app (a static export, so the constant is compiled in), the SDK, the services when the file is not set |

`packages/core/test/deployments.test.ts` asserts the two agree for chain
5042002, so a redeploy that updates one and not the other fails CI.

Other places that carry an address and have to be updated by hand:

- `README.md`, the deployments table and the deploy sentence
- `contracts/README.md`, the deployments table
- `site/src/lib/links.ts`, the explorer link of the kernel
- `contracts/src/PolicyRegistry.sol`, the docstring that names the deployed hook
- the explorer itself: every deployment table here links to Arcscan, so an
  address that is not verified there shows bytecode to whoever follows the link

### What the chain has to agree with before anyone calls the deploy done

Three reads, all free, and one of them is now a CI job:

```bash
cd packages/core && npm run check:selectors
```

It takes every function in the SDK's ABI, computes its selector, and looks for
it in the `eth_getCode` of the address the record names. A selector the SDK
calls and the bytecode does not carry means the stack is behind `main`, which is
exactly the state that made `finalize`, `buy` and every `policyRegistry()` read
revert on the live stack after 2026-09-13. The same run asks the explorer whether
each address is verified. The job is `deployed selectors (Arc Testnet)` and it is
deliberately not in the required contexts while the shared stack is behind: add
it to the required list once a redeploy has made it green.

The other four are one line each:

- `PolicyRegistry.isSpender(ComplianceModule)` is true. `recordSpend` is
  `onlySpender`, so a registry with no spender can never move its daily counter,
  and a stack whose ceiling cannot move is a ceiling in name only. The deploy
  script registers it; this is the read that proves it did.
- `SquareHook.complianceModule()` is what you meant it to be. The script installs
  a module on the hook only when `INSTALL_COMPLIANCE_MODULE=true`, because once
  installed every release needs a proof bound to the job.
- `SquareHook.screening()` is what you meant it to be. The script deploys a
  `ScreeningRegistry` always and installs it on the hook when
  `INSTALL_SCREENING=true`, which is what `deploy-arc-testnet.sh` defaults to
  since #372 decided the shared stack screens; once installed nobody can fund
  and no payee can be paid without a fresh clean screening (#370).
- `ScreeningRegistry.isScreener(<the screener's address>)` is true whenever
  screening is installed. The script registers `SCREENER_ADDRESS` when one is
  given, and `deploy-arc-testnet.sh` refuses to broadcast an installed registry
  with no screener: a registry that recognises no screener clears nobody, so it
  would stop every hire and every release on that hook.

### The balance a redeploy has to reach zero

`redeploy-2026-09-09.md` records the success condition for the stack it
replaced: `totalWithdrawable` and the kernel's USDC balance both read zero
afterwards. That is the right condition and the current stack can no longer
meet it by the runbook's three steps alone, because `0x76E8690cEa9d94df810eE6b1F453866f0ee68c7B`
holds 0.009602 USDC that arrived as a plain ERC-20 transfer in block 61250488
and belongs to no ledger entry and no escrow.

`unaccounted()` names that balance and `skim(to)` moves it, and neither can
touch the ledger: `skim` transfers `balanceOf(this) - totalWithdrawable -
totalEscrowed` and nothing else. The live kernel predates both, so its
0.009602 USDC stays where it is until the stack is superseded by one that
carries them. The supersede checklist in
[contracts/README.md](../../contracts/README.md) now reads the balance to zero
rather than assuming the withdrawals got there.

### The commit it was compiled from, and the explorer

`deploy-arc-testnet.sh` passes `--verify --verifier blockscout` and writes
`commit` and `compiler` into the record, because those two plus `foundry.toml`
are everything a later verification needs and the explorer cannot answer for us.
`VERIFY=0` turns verification off when the explorer is down; the addresses are in
the record either way and `forge verify-contract --verifier blockscout` takes
them one at a time afterwards.

This matters more than it looks. Every deployment table in this repository links
to Arcscan, and until the flag existed a reader following one of those links got
bytecode and no `Read contract` tab, while the ERC-8004 registries on the same
chain were verified and readable. An auditor, a Circle engineer or anyone doing
diligence sees the contracts we point them at as an unreadable blob.

### The block, and who needs it

The deploy script also writes `"block"` into `contracts/deployments/<chainId>.json`,
the block the stack was deployed in. The indexer reads it through
`deploymentFromJson` whenever `START_BLOCK` is unset, so the number that decides
where indexing starts comes from the same record as the addresses rather than
from an operator's memory. `packages/core/src/deployments.ts` carries no block:
the compiled constants are for the app and the SDK, neither of which indexes.

An indexer given neither a `START_BLOCK` nor a record with a block refuses to
start. That is deliberate: the old default was zero, and on Arc that is about a
day of catching up from genesis with the lag check red throughout.

## 3. After the deploy

1. Read the parameters back from the chain and record them
   (`settlementHorizon`, `finalizeGrace`, `currentWindow`, `MAX_DESCRIPTION`,
   `hookGasLimit`, the fees, `whitelistedHooks(hook)`, `payoutMarket`,
   `trustedEvaluator`, `minReputationBudget`, `complianceModule`, `screening`,
   `bondParameters`, `arbiterSet`), and for the screening registry the record
   names, `maxAge()` and `isScreener()` of the screener's address.
2. Sweep the superseded stack: finalize or reject every job still `Submitted`
   on the old `KeeperEvaluator`, have every account with a balance call
   `withdraw()` on the old `SquareJob` and `Arbitration`, and record the
   transactions and what remains claimable by whom (#101).
3. Run the lifecycle against the new stack
   (`packages/core/scripts/lifecycle-arc-testnet.sh`). The report is written as
   a dated file, `docs/deploy/lifecycle-5042002-<date>.md`, and
   `docs/deploy/lifecycle-5042002.md` points at the latest. With a keeper
   running against the stack (#336), run it with `LIFECYCLE_FINALIZER=keeper`
   and a budget above the keeper's bar, so that the keeper's transactions are
   the report's and its "The eight steps" table is #31's evidence
   ([docs/design/mandate-to-payment.md](../design/mandate-to-payment.md)).
4. Write `docs/deploy/redeploy-<date>.md`: addresses, deploy transactions, the
   parameter table, the read-back, the sweep, and a link to the lifecycle report.
5. Deploy the app and the site (`vercel --prod` at the repository root and in
   `site/`), then check the served bundle carries the new kernel address.

## 4. Documents a redeploy makes stale

Each of these quotes a measurement from a specific stack. After a redeploy,
either refresh the numbers from the new lifecycle report or mark the section as
belonging to the superseded stack by name (#158, #161, #169):

| Document | What it quotes |
|---|---|
| `docs/deploy/gas.md` | receipts of an acceptance run and a comparison against the current lifecycle report |
| `docs/design/keeper-economics.md` | the finalize gas and the break-even table derived from it |
| `docs/deploy/services-5042002.md` | recorded `/health` and `/status` bodies and the block range of a run |
| `packages/aa/README.md` and `docs/decisions/erc4337-sponsorship.md` | the live AA measurement |
| `docs/deploy/lifecycle-5042002.md` | regenerated by the runner; the dated copy is the record |
| `docs/design/mandate-to-payment.md` | "Measured": the fork rehearsal until the shared stack's run, then that run's dated report and its "The eight steps" table |

### Rehearsing it first

The deploy is meant to happen once, so rehearse it before it does:

```bash
BROADCAST=0 INSTALL_SCREENING=false contracts/script/deploy-arc-testnet.sh
```

Everything runs except the broadcast and the verification: the chain id is
checked, the environment is read, the contracts compile, and forge simulates all
fourteen transactions and writes them under
`contracts/broadcast/DeploySettlement.s.sol/5042002/dry-run/`. Read that file to
see exactly what the real run would create before it creates it. The rehearsal
costs nothing and needs no faucet.

Two things the rehearsal has already caught. `INSTALL_SCREENING` defaults to
true and `SCREENER_ADDRESS` defaults to the zero address, and the script refuses
that combination, so the deploy stops before broadcasting unless one of the two
is set. And an `[etherscan]` entry carrying `chain = 5042002` made `forge script`
itself fail with "Chain 5042002 not supported", because forge cannot resolve a
chain id it does not know; the entry keeps its url and loses the field.

## 5. Source changes not yet on chain

Contract changes that merged after the last deploy and wait for the next one
are listed here so that "the deployed bytecode is behind main" is a written
state rather than a surprise:

- `SquareHook`: the compliance outcome is three-state and keyed by job, so a
  hook call that never ran writes no validation verdict (#154). Dormant on the
  deployed hook, which carries no compliance module.
- `PolicyRegistry` is not deployed on Arc Testnet; `recordSpend` answers with a
  verdict instead of reverting (#180).
- `KeeperEvaluator`: `finalize(uint256)` and `finalizeDecided(uint256)` carry
  no compliance proof, since the hook reads the proof the client bound to the
  job (#245, #307). The deployed 2026-09-09 evaluator still exposes
  `finalize(uint256,bytes)`, and `packages/core` on main calls the new selector,
  so the app and the keeper must not be deployed from main against that stack:
  their finalize would revert on a function the old contract does not have.
  Redeploy the stack first, then the app and the services, in that order.
- `Arbitration`: `settleBond` routes an expired job's bond by the decision
  rather than always to the disputer (#265), and `vote` refuses a terminal job
  (#266). The keeper on main cranks `settleBond` for expired disputed jobs
  (#311), which works against the deployed contract as well.
- `SquareJob`: `setComplianceProof`, `skim`, `unaccounted`, the fee notice
  (`setFees` applies after `FEE_NOTICE`) and the fifteen minute floor on the
  submit window (#240, #244, #245, #248). The app on main reads
  `scheduledFees` and `complianceProofOf` only where the deployment exposes
  them; a stack redeploy is what makes them live.
- `SquareJob`: `createJob` and `fund` refuse an expiry the settlement window
  cannot fit, so a job the provider could never deliver never holds money, and
  `netPayout` on an open job reads the fee a funding would pin rather than the
  raw fields (#326, #327). The deployed kernel still creates and funds such a
  job and still previews the stale fee.
- `KeeperEvaluator`, `SquareHook`, `ComplianceModule`: a job with no decidable
  proof no longer settles. `finalize` and `finalizeDecided` revert
  `ProofRequired`, the policy commitment is pinned at funding and read back
  through `commitmentAtFund`, and a client with no mandate cannot fund a gated
  job (#382). The evaluator's question to the hook is capped at the kernel's
  hook gas limit (#400).
- `ScreeningRegistry` is not deployed on Arc Testnet. `DeploySettlement` now
  deploys it, registers a screener and installs it on the hook behind
  `INSTALL_SCREENING` (#370).
- `SquareJob.payoutOf` and `SquareHook.proofState`, `commitmentAtFund`,
  `settlementFacts`: the reads the evidence record is built from. Every settled
  job leaves an ERC-8004 record committing to what it paid (#405, open at the
  time of writing).
