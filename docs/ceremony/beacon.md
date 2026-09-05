# The beacon

**Chosen source: drand, `quicknet` chain, at a round announced before the
ceremony opens.**

A phase-2 contribution chain is sound if at least one contributor destroyed
their entropy. A beacon removes the need to believe that of anyone: it mixes in
randomness that nobody could have known while contributing and that everybody
can check afterwards. Without one, a chain of contributors who all colluded is
indistinguishable from an honest one.

The value only does that job if it was **unpredictable when the ceremony ran**
and **verifiable after**. Announcing which value it will be, in advance, is what
makes both true — a beacon picked after the fact proves nothing.

## The parameters

| | |
|---|---|
| Network | drand mainnet, `quicknet` |
| Chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Scheme | `bls-unchained-g1-rfc9380` |
| Genesis time | `1692803367` |
| Period | 3 seconds |
| Round | **announced with the schedule, before invitations go out** |

The round number is a pure function of the wall-clock time it lands on:

```
round(T) = floor((T - 1692803367) / 3) + 1
```

Checked against the live chain while writing this — the formula and the network
agree exactly:

```console
$ curl -s https://api.drand.sh/v2/beacons/quicknet/rounds/latest
{"round":31941134,"signature":"b6d7e5a43775e89688d3ceef6452aabd524f7f1d..."}

  round from the formula for the current time : 31941134
  round reported by the network               : 31941134
```

So the announcement can name a date and a round together and neither can drift
from the other.

## Why drand rather than a block hash

**A Bitcoin or Ethereum block hash** is the traditional choice and it is
grindable: a miner or proposer who dislikes the outcome can drop a block and
take the next one. The cost is small next to what a compromised setup is worth.
Block height also does not map cleanly to a wall-clock time, so "the block at
15:00 UTC" is not a well-defined statement in advance.

**drand** is a threshold network — no single participant can predict or
withhold a round, the value is a BLS signature anyone can verify against the
chain's public key, and rounds land on a fixed 3-second schedule so a future
round has an exact time. It is the beacon the Ethereum Foundation KZG ceremony
used, which also means the tooling and the verification story are familiar to
anyone reviewing this.

**NIST's beacon** is verifiable but singly-sourced: one authority could in
principle produce a value it liked. The point of the beacon is not to add
randomness, it is to remove the need to trust a party — so a source with one
party defeats it.

## How it gets used

1. The round is announced with the schedule, before any invitation goes out, in
   the ceremony announcement and in this file.
2. Contributions are collected. Each contributor gets a transcript.
3. After the last contribution, and not before, the round's randomness is
   fetched and applied:

   ```bash
   # the announced round, once it exists
   curl -s https://api.drand.sh/v2/beacons/quicknet/rounds/<ROUND> \
     | tee beacon-round-<ROUND>.json

   # randomness = sha256(signature)
   BEACON=$(python3 -c "import json,hashlib;print(hashlib.sha256(bytes.fromhex(json.load(open('beacon-round-<ROUND>.json'))['signature'])).hexdigest())")

   snarkjs zkey beacon payment_NN.zkey payment_final.zkey "$BEACON" 10 \
     -n="drand quicknet round <ROUND>"
   ```
4. `beacon-round-<ROUND>.json` is published with the transcripts, so a third
   party can re-verify the BLS signature against the chain's public key and
   confirm the value was not chosen.

`10` is the iteration exponent snarkjs applies to the beacon hash; it is
recorded in the final key and reported by
`circuits/scripts/inspect-zkey-setup.mjs`, which reads the beacon hash and
iteration count straight out of the zkey.

## What has to be true when the ceremony closes

- The round number in the final key's beacon parameter is the announced one.
- Its randomness matches what drand publishes for that round, and the signature
  verifies against the `quicknet` public key.
- The round's timestamp is **after** the last contribution's timestamp. A beacon
  that existed while contributions were still open is not a beacon.

`inspect-zkey-setup.mjs` reports the first; the published `beacon-round-*.json`
and the transcripts cover the other two.

## Still to fill in

The round number itself, once the date is set. Everything above is decided; that
one field waits on the schedule in [README.md](./README.md).
