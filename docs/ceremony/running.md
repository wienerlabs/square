# Running the ceremony

The operational half of [#16][i16]. [README.md](./README.md) is the plan and the
open decisions; this is what the coordinator actually types.

Every step goes through `circuits/scripts/ceremony.mjs`, which keeps a
transcript as it goes rather than reconstructing one afterwards. The transcript
is the published record, so it has to be written by the thing doing the work.

[i16]: https://github.com/wienerlabs/square/issues/16

## Before anything

The announcement must already be out, with the beacon round in it. A beacon
chosen after contributions have been collected proves nothing — see
[beacon.md](./beacon.md). The round number is what makes "we could not have
known this in advance" checkable, and it is only checkable if it was public
before the first contribution.

```bash
cd circuits
npm install
npm run build -- --no-zkey     # compiles the circuit; the ceremony makes the key
```

## Opening

```bash
node scripts/ceremony.mjs init
```

Creates `build/ceremony/payment_0000.zkey` from the compiled circuit and the
adopted phase-1 powers of tau, and starts the transcript with the circuit hash
and the phase-1 provenance. It refuses to run if a transcript already exists:
restarting a ceremony silently would destroy the only record of the first one.

Nothing in this file is secret. Publish it.

## Each contribution

The contributor runs this on a machine they trust, against the key they
received:

```bash
node scripts/ceremony.mjs contribute "Their Name or Organisation"
node scripts/ceremony.mjs verify
```

`contribute` hands over to snarkjs, which prompts for a random text. Type
something only you can see. It is mixed with 64 bytes snarkjs draws from the
operating system, so it does not need to be long — and it must not be written
down, pasted, or shared.

The script does not generate that value or pass it as an argument, and this is
deliberate. An earlier version did both: it echoed the command it ran, so the
entropy landed in the contributor's terminal, and it sat in `argv` where `ps`
exposes it to every other process on the machine. Since these same instructions
ask contributors to publish the hashes their terminal printed, that was a route
from "destroy this value" to "publish it" in one copy-paste. The strongest shape
is the one where the script never holds the secret at all.

`contribute` then records the contribution's transcript hash and the new key's
SHA-256, and prints both — those are public. `verify` re-derives the chain so
far against the circuit and the phase-1 file, so a broken link is caught at the
step that broke it rather than at the end.

Publish the printed hashes as each contribution lands. The next contributor
checks the key they received against the previously published hash — that is
what stops a key being swapped between links, and it only works if the hashes
are public while the ceremony is still running.

Then the contributor destroys their entropy. If they typed it and never wrote
it down, that is already done; closing the shell finishes it. The soundness of
the whole chain is one contributor doing exactly that, so it is worth saying out
loud rather than assuming it is obvious.

## Closing

When the window shuts, apply the announced round:

```bash
node scripts/ceremony.mjs beacon <announced round>
node scripts/ceremony.mjs finalize
```

`beacon` fetches the round from drand, checks the chain hash, genesis and period
against what [beacon.md](./beacon.md) announced — a round number means nothing
without the chain it counts on — and uses the round's BLS signature as the
randomness. It refuses to run on a chain with no contributions: a beacon applied
to a key this project generated alone is not a ceremony, and the transcript
would be claiming otherwise.

`finalize` exports the verifying key and completes the transcript.

## Checking it

One command, and it is the same one a third party runs:

```bash
node scripts/ceremony.mjs verify-chain
```

It checks the phase-1 file by hash, the compiled circuit against the hash the
ceremony started from, the final key against circuit and ptau, the contribution
count against the transcript, and the beacon two ways: the value drand publishes
for that round, fetched live rather than read from the transcript, and the
round's BLS signature against quicknet's group public key. The second is what
separates "matches what drand told me" from "is what drand produced" — an
auditor whose DNS or TLS path is compromised gets the right answer anyway. It
exits non-zero if anything fails, and it reports every failure rather than
stopping at the first.

[verifying.md](./verifying.md) walks the same ground with individual `snarkjs`
commands, for anyone who would rather not run our script to check our ceremony.
That is the better instinct and the reason both exist.

## What it looks like when it works

From a rehearsal against the real drand chain, with throwaway contributions.
This is not the ceremony — it is the evidence that the machinery does what this
document says.

```console
$ node scripts/ceremony.mjs verify-chain
phase 1
  ok    ppot_0080_13.ptau matches the adopted Perpetual Powers of Tau contribution 80

circuit
  ok    the compiled circuit matches the one the ceremony started from

chain
  ok    the final key verifies against the circuit and the adopted ptau
  ok    2 contribution(s), matching the transcript

beacon
  ok    beacon is drand quicknet round 31968374, matching the public chain
  ok    the round's BLS signature verifies against quicknet's group key
  ok    round 31968374 corresponds to 2026-09-06T15:28:06.000Z

keys
  ok    the verifying key is the one the transcript records

All checks passed. The chain is what the transcript says it is.
```

And when it does not. A transcript claiming a different round than the key
actually carries:

```console
$ node scripts/ceremony.mjs verify-chain
beacon
  FAIL  beacon in the key does not match drand round 31966441
  FAIL  the recorded round and time disagree

2 check(s) failed.
$ echo $?
1
```

A chain with a single contributor is rejected as well, whatever else is in
order:

```console
  ok    1 contribution(s), matching the transcript
  FAIL  fewer than two independent contributions — this is not a multi-party ceremony
```

## Publishing

The transcript, every contribution hash, the final key, the verifying key and
the beacon round go wherever [README.md](./README.md) says — that location is
one of the open decisions. [verifying.md](./verifying.md) assumes all of it is
fetchable without asking anyone, which is the standard to publish against.

Once that is done [#16][i16] closes,
[#17](https://github.com/wienerlabs/square/issues/17) generates the Solidity
verifier from the final key, and the demo-setup language tracked by
[#3](https://github.com/wienerlabs/square/issues/3) comes off.
