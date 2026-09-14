# The proof is the client's duty, timed to the release, not a step of funding

**Status:** decided and implemented for [#335][i335] and [#338][i338]. Binds
`packages/policy`, the `square policy` commands, `square_hire` in
`packages/mcp`, the hosted agent's delegation in `packages/hosted`, the
lifecycle runner and the app's policy and job pages; rests on the module's
bindings ([docs/design/compliance-gate.md](../design/compliance-gate.md)) and
on [#245][i245], which made the proof the client's to bind.

[i335]: https://github.com/wienerlabs/square/issues/335
[i338]: https://github.com/wienerlabs/square/issues/338
[i245]: https://github.com/wienerlabs/square/issues/245
[i16]: https://github.com/wienerlabs/square/issues/16
[i329]: https://github.com/wienerlabs/square/issues/329
[i337]: https://github.com/wienerlabs/square/issues/337

## The question

The product's sentence is that a release out of escrow proves, in zero
knowledge, that the payment fits the institution's mandate. Until this
decision nothing on the institution's side produced that proof: the SDK had
no `setComplianceProof`, and `square_hire`, the hosted agent, the CLI and the
app funded jobs and never proved anything. That is why the shared stack's
hook slot is empty and why `DeployLocal.s.sol` installs the module only on
request: with a module in place, every release from those paths would have
paid the client back ([compliance-gate.md](../design/compliance-gate.md),
"it is not installed by default on a dev chain").

The obvious shape, "prove when you fund", does not work, and the reason is
in the module's bindings. A proof is a statement about eight public signals,
and four of them describe the release as the chain will make it: the payee
the hook resolves (the buyer of a sold receivable, else the provider), the
net after fees and after the split a decided dispute set, the day's counter
`spentToday(client)` at that moment, and a timestamp within the module's
tolerance of the releasing block. Every one of these can move between funding
and release: a sale changes the payee, a fee notice the net, every other
release of the day the counter, and the clock always. A proof built at
funding is stale by release on any chain where the challenge window is longer
than the tolerance, which is every chain the module is deployed on.

## The decision: a duty that keeps the proof current, and cranks

**The proof is the client's, and keeping it current is a duty the client's
software carries for every job it has open.** `packages/policy` implements it
as `ComplianceDuty`: track a job when it is funded, and on a cadence well
inside the module's tolerance read what the release would bind to
(`releaseFacts`), compare it with the proof the job carries (`proofState`),
and rebuild and rebind when they differ or when the proof has aged past half
the tolerance. Nothing is kept off chain but the policy itself; the proof
lives on the job (`SquareJob.complianceProofOf`), and the duty reads it back
rather than remembering it.

**Once the window has closed, the duty cranks the job itself.** `finalize`
is permissionless and pays its caller, and a keeper that finds the job first
releases it with whatever proof is bound at that instant. A duty that only
kept the proof fresh would still lose the race in the seconds between a
counter moving and the next rebind. So after a rebind that leaves the proof
current, and only then, the duty sends `finalize` (or `finalizeDecided` once
the arbiters have decided); a keeper's crank that lands first is read back
as a settlement, not an error, and the escrow moves once either way. The
keeper is not made aware of any of this: to it a job with a current proof is
a job like any other.

**A release the policy refuses is reported, not bound.** The circuit proves
the six checks ran, not that they passed, and a proof with `is_compliant = 0`
is refused at release the way no proof is. The prover names the rules that
failed, so the duty reports them and binds nothing; binding would only spend
gas to make the module say the same thing.

**The policy file is the secret, and it travels only to the prover.** The
eight leaf salts derive from `policy_salt`; whoever holds it can open the
committed values. The file stays with the institution: on disk for the CLI,
the MCP server and the hosted agent, in the browser's storage for the app,
and in a `POST /prove` to the prover the institution runs or trusts. The
commitment, the buyer list's root and the proof bytes are what reach the
chain.

## What each surface does

| Surface | Commit the policy | Keep proofs current | Crank |
|---|---|---|---|
| `square policy` (CLI) | `commit` | `prove`, `watch` | `prove --release`, `watch` |
| `square-mcp` | no (the CLI or the app) | every `square_hire` job, for the server's life (`SQUARE_POLICY_FILE`, `SQUARE_PROVER_URL`) | yes |
| `square-hosted` | no | every delegated job, for the host's life (`compliance` block) | yes |
| app | Policy page | job page, `Bind proof`, when `NEXT_PUBLIC_PROVER_URL` is set | the existing `Finalize` action |
| lifecycle runner | on first run (`LIFECYCLE_POLICY_FILE`) | before each release it cranks | as before |

## What this does not decide

- **Whether the shared Arc stack installs the module.** That is the deploy's
  call once [#329][i329] gives `DeploySettlement` a wired module; this work
  is what makes installing it survivable. Until then the shared stack's
  releases are not proof gated and the duty says so once and does nothing.
- **The key.** A module keyed to a development proving key is what a dev chain
  gets ([#16][i16] and [#337][i337] are the ceremony and the verifier it
  replaces). `packages/policy/scripts/install-module-for-this-build.mjs` keys
  a local module to the prover beside it; on the shared stack the key is the
  ceremony's.
- **The race between two releases of one day.** Two of the institution's jobs
  whose windows close in the same tick are cranked in sequence, each rebound
  after the other moved the counter. A keeper that cranks the second between
  those two steps releases it without a current proof and pays the client
  back. The window for that is one block; narrowing it further means either
  a counter the module tolerates a lag on, or a keeper that reads
  `complianceProofOf` before cranking, and both are the contracts' and the
  keeper's to decide.
