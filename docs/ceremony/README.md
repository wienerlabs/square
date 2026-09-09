# The trusted setup ceremony

Organisation for the ceremony that [#16][i16] runs. Coordination, not code —
invitations and a schedule take weeks, and the circuit froze in [#14][i14], so
this has to be ready when #16 opens rather than started then.

| | Where | State |
|---|---|---|
| Phase 1 — which powers of tau, and its provenance | [phase1-ptau.md](./phase1-ptau.md) | **Decided and verified** |
| Beacon — source, and how it is announced | [beacon.md](./beacon.md) | **Decided.** Round number waits on the date |
| Verification — what contributors and third parties run | [verifying.md](./verifying.md) | **Written** |
| Invitations and schedule | this file | **Needs names and dates** |

[i14]: https://github.com/wienerlabs/square/issues/14
[i16]: https://github.com/wienerlabs/square/issues/16

## Why phase 1 is settled and phase 2 is not

The setup inherited from aperture is development quality in **both** halves:
phase 2 has a single contribution and no beacon, and phase 1 was generated
locally rather than taken from a public ceremony —
[#51](https://github.com/wienerlabs/square/pull/51) established the second
part by reading the key rather than the comments around it.

Phase 1 is now settled by adoption rather than by running anything: the
Perpetual Powers of Tau is a public ceremony with 80 contributions, and joining
it beats re-running it privately. So #16 only has to run **phase 2** — but it
has to run it properly, because refreshing phase 2 on top of a locally generated
tau would have left the key standing on one machine's entropy anyway.

## Shape of the ceremony

Phase 2 is sequential: each contributor receives the previous key, mixes in
their own randomness, and passes it on. One honest contributor who destroys
their entropy is enough to make the setup sound — which is why the number of
contributors matters less than their independence from each other and from us.

```
payment.r1cs + ppot_0080_14.ptau
        │
        ▼
  payment_0.zkey  ── contributor 1 ──▶ payment_1.zkey ── … ──▶ payment_N.zkey
                                                                     │
                                                    drand round R ────┤
                                                                     ▼
                                                            payment_final.zkey
                                                                     │
                                                       verifying key ┘  → #17
```

Contributions are collected one at a time and each is verified before the next
one starts, so a broken link is caught immediately rather than at the end.

## What still needs deciding

These are the open items. Everything else in this directory is settled.

### 1. Contributors

The issue asks for **at least one institutional participant from the Arc
ecosystem or around Circle**, on the grounds that it moves the proof from
"some developers ran a script" to something an institution can point at. That
judgement is right and it is the single highest-value invitation.

Needed:

- [ ] Target number of contributors
- [ ] The invitation list, with who asks whom
- [ ] At least one institutional participant confirmed

A contributor needs `snarkjs`, a machine they trust, and about ten minutes.
Nothing else — no wallet, no key material, no on-chain transaction. Worth saying
in the invitation, because people assume otherwise.

Independence is what the list is buying. Ten contributors from one company are
worth roughly one contributor.

### 2. Schedule

- [ ] Contribution window opens
- [ ] Contribution window closes
- [ ] Beacon round applied — a time, from which
      [beacon.md](./beacon.md)'s formula gives the round number
- [ ] Final key and transcripts published

The beacon round must be announced **with** the schedule and before invitations
go out. A beacon chosen afterwards proves nothing, so this ordering is not a
formality.

Sequencing note: the beacon time has to sit after the last contribution with
enough slack that one slow contributor does not force a re-announcement. Rounds
are three seconds apart, so the round number is exact once the time is.

### 3. Where transcripts are published

- [ ] Repository, path, and format

Each contributor's hash, the final key, the beacon round's signed value, and
the verifying key. [verifying.md](./verifying.md) assumes these are all fetchable
without asking anyone.

## The announcement

Fill in the four bracketed values and this is publishable as-is.

> **Square is running a public phase-2 trusted setup ceremony.**
>
> Square gates agent payments on a Groth16 proof that the payment fits a
> spending mandate the operator committed on-chain. That proof rests on a
> trusted setup. Such a setup is sound only if at least one contributor
> destroyed their randomness afterwards. We are asking people to be that
> contributor.
>
> Phase 1 is the Perpetual Powers of Tau, contribution 80 — adopted, not run by
> us, and hash-verifiable. Phase 2 is the circuit-specific half and is what this
> ceremony produces.
>
> - **Contributions open:** [DATE]
> - **Contributions close:** [DATE]
> - **Beacon:** drand `quicknet` round **[ROUND]**, which lands at [DATE TIME] UTC.
>   Announced now, before any contribution, so nobody can pick it afterwards.
> - **Transcripts:** [WHERE]
>
> Contributing takes about ten minutes and needs only `snarkjs` and a machine
> you trust — no wallet, no key material, no transaction. Instructions and the
> verification steps are at
> `docs/ceremony/verifying.md` in github.com/wienerlabs/square.
>
> Until this completes, the setup in that repository is a development setup and
> we describe it that way everywhere.

## Once it is done

[#16][i16] closes with the final key, the verifying key and the transcripts
published. [#17](https://github.com/wienerlabs/square/issues/17) generates the
Solidity verifier from that key and deploys it.
[#3](https://github.com/wienerlabs/square/issues/3) — the demo-setup language
that this repository carries everywhere — comes off only then, and
[docs/disclosure/zk-setup-status.md](../disclosure/zk-setup-status.md) is
rewritten to match.
