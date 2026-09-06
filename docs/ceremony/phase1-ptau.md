# Phase 1: the adopted powers of tau

**Adopted:** Perpetual Powers of Tau, contribution 80, truncated to power 13 —
`ppot_0080_13.ptau`.

Phase 1 of a Groth16 setup is universal: it is not circuit-specific, it does not
have to be run by us, and re-running it privately would be strictly worse than
joining a ceremony that dozens of independent parties have already contributed
to. What we do owe anyone reading this is the exact file, proof that the bytes
are that file, and a way to check both without trusting us.

| | |
|---|---|
| Ceremony | [Perpetual Powers of Tau](https://github.com/privacy-ethereum/perpetualpowersoftau) |
| Contribution | 80 |
| Power | 13 (8192 points) |
| File | `ppot_0080_13.ptau` |
| Size | 9,530,514 bytes |
| SHA-256 | `ccee28086e4b81d81a6e16fdee054d1dbd5276362e2662d4205d31de45cb930f` |
| BLAKE2b | `bf0c2d498f1197ad04ec0dbfcdda6df6348cbd793759f1f986e5cdf1a4100842293dfad6b8961f64b7ba35c162b5c821c4c097a52f3a639b55b0e765ec311b44` |
| Source | `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_13.ptau` |

`circuits/scripts/fetch-ptau.mjs` holds these values and refuses any file that
does not match them, so a proving key cannot quietly end up standing on an
unidentified tau.

## Why power 13

`payment.circom` compiles to a domain size of 8192 = 2^13, so 13 is the smallest
truncation that fits. A larger one is not safer — the extra powers are never
read — and costs 9.5 MB more to download at power 14. If the circuit ever grows
past 8192 constraints the power has to go up, and that is a new adoption record,
not a silent edit.

## Why contribution 80 rather than the file everyone links to

Almost every circom tutorial, the snarkjs README, and tools like circomkit point
at `powersOfTau28_hez_final_NN.ptau` under `storage.googleapis.com/zkevm/ptau/`.
**That bucket returns 403.** So does the Hermez S3 bucket, and the Azure bucket
the ceremony originally used. Checked while writing this:

```console
$ curl -sIL -o /dev/null -w '%{http_code}\n' \
    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau
403
$ curl -sIL -o /dev/null -w '%{http_code}\n' \
    https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau
403
```

The copies on GitHub are Git LFS pointers whose LFS objects are not fetchable.
So the file the ecosystem tells you to use cannot currently be obtained, which
is a poor basis for a ceremony we intend anyone to be able to reproduce.

The ceremony's own repository publishes contribution 80 on a bucket that is
live, and 80 contributions is more than the Hermez snapshot's ~54. <!-- ci-allow-phrase -->
Adopting the newer one is better on both counts.

## Verifying it

Two independent checks, and neither requires trusting this document.

**The bytes are the file we adopted.** Content-addressed, so any mirror will do:

```console
$ node circuits/scripts/fetch-ptau.mjs --verify
ppot_0080_13.ptau
  9530514 bytes
  sha256  ccee28086e4b81d81a6e16fdee054d1dbd5276362e2662d4205d31de45cb930f
  blake2b bf0c2d498f1197ad04ec0dbfcdda6df6348cbd793759f1f986e5cdf1a4100842293dfad6b8961f64b7ba35c162b5c821c4c097a52f3a639b55b0e765ec311b44
  matches the adopted Perpetual Powers of Tau contribution 80
```

**The contribution chain is cryptographically sound.** This checks every
contribution in the file rather than its name, and takes a while:

```bash
snarkjs powersoftau verify ppot_0080_13.ptau
```

**A key built on it is recognisably built on it.** `vk_alpha_1` and `vk_beta_2`
are copied out of the ptau during setup and never touched by phase-2
contributions, so they fingerprint the tau. `inspect-zkey-setup.mjs` knows this
ceremony's pair:

```console
$ node circuits/scripts/inspect-zkey-setup.mjs build/payment.zkey
phase-1 ceremony         Perpetual Powers of Tau, contribution 80 (ppot_0080_*)
  vk_alpha_1             16428432848801857252194528405604668803277877773566238944394625302971855135431
                         16846502678714586896801519656441059708016666274385668027902869494772365009666
...
ASSESSMENT
  phase 1: built on Perpetual Powers of Tau, contribution 80 (ppot_0080_*).
           alpha and beta match the published ceremony, so the tau behind this
           key is the public one and not a locally generated substitute.
  phase 2: single contribution, no beacon. ...
```

That pair appears in a few hundred unrelated public repositories, which is what
a shared ceremony looks like and what a privately generated tau never does.

## What this does and does not settle

**Settled.** Phase 1 is no longer ours to trust. A key built with
`circuits/scripts/build.mjs` now stands on 80 public contributions, and the
tooling says so out loud instead of asserting it in a comment.

**Not settled.** Phase 2 is still a single contribution from one machine with no
beacon, so the key as a whole remains a development key and nothing built on it
carries an assurance claim. [#16][i16] fixes that; [beacon.md](./beacon.md) and
[verifying.md](./verifying.md) are what it needs to be ready.

This replaces the earlier belief that phase 1 was already the Hermez file. It
was not — the shipped key's alpha and beta matched no published ceremony, which
is what [#51](https://github.com/wienerlabs/square/pull/51) established and why
the check now lives in a script.

[i16]: https://github.com/wienerlabs/square/issues/16
