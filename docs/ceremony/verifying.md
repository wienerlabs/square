# Verifying the ceremony

Written so that nothing here requires trusting us. Every step is a command you
run against files you fetched yourself.

There are two audiences. **Contributors** check that their own randomness made
it in and that nobody rewrote the chain around them. **Third parties** check the
whole chain from the outside, having contributed nothing.

## What you need

```bash
npm install -g snarkjs      # 0.7.5 or later
git clone https://github.com/wienerlabs/square.git
cd square/circuits && npm install
```

`circom` is only needed if you want to rebuild the circuit and confirm the
constraint system independently, which the last section covers.

---

## For contributors

### Before you contribute

The file handed to you must be the chain so far, not something else.

```bash
# 1. The previous contributor's published hash must match what you received.
snarkjs zkey verify payment.r1cs ppot_0080_13.ptau payment_<N-1>.zkey
```

That command re-derives the whole chain from the circuit and the powers of tau
and confirms every contribution up to `N-1`. If it fails, stop and say so
publicly — do not contribute on top of it.

Check the powers of tau it names is the adopted one:

```bash
node scripts/fetch-ptau.mjs --verify
```

### Contributing

Your entropy must come from you and must not be recoverable afterwards.

```bash
snarkjs zkey contribute payment_<N-1>.zkey payment_<N>.zkey \
  --name="<your name or handle>" -v
```

`-v` prompts for entropy interactively rather than taking it from the command
line, which keeps it out of your shell history. Type a long, unpredictable
string; move on with your life; do not write it down anywhere.

snarkjs prints a **contribution hash** when it finishes. Publish it — a comment
on the ceremony issue, a signed message, a post, anywhere public and timestamped.
That published hash is what lets you prove later that the chain still contains
your contribution and not a substitute.

### After the ceremony closes

```bash
snarkjs zkey verify payment.r1cs ppot_0080_13.ptau payment_final.zkey
```

Then find your contribution hash in the transcript and confirm it is the one you
published. If the chain was rewritten to drop or replace your contribution, this
is where it shows.

---

## For third parties

You are checking four separate claims. They fail independently, so check them
separately.

### 1. Phase 1 is the ceremony it claims to be

```bash
node scripts/fetch-ptau.mjs --verify        # bytes are the adopted file
snarkjs powersoftau verify ppot_0080_13.ptau  # the contribution chain is sound
```

The first is content-addressed, so it does not matter where you got the file.
The second checks the phase-1 contributions cryptographically and takes a while.
Provenance and the reason for this particular file are in
[phase1-ptau.md](./phase1-ptau.md).

### 2. The final key descends from that phase 1, and from the published contributions

```bash
snarkjs zkey verify payment.r1cs ppot_0080_13.ptau payment_final.zkey
```

This is the load-bearing check. It re-derives the entire setup and confirms the
final key is what the published chain produces — not merely that the files are
well-formed.

### 3. The beacon is the announced one, and it came after the contributions

```bash
node scripts/inspect-zkey-setup.mjs payment_final.zkey
```

Read off the beacon hash and iteration count, then confirm the value against
drand independently:

```bash
curl -s https://api.drand.sh/v2/beacons/quicknet/rounds/<ROUND> | tee round.json
python3 -c "import json,hashlib;print(hashlib.sha256(bytes.fromhex(json.load(open('round.json'))['signature'])).hexdigest())"
```

Three things must hold, and the third is the one people forget:

- the printed hash matches the beacon in the key;
- the round is the one announced in [beacon.md](./beacon.md) **before** the
  ceremony opened;
- the round's timestamp, `1692803367 + (round - 1) * 3`, is later than the last
  contribution.

A beacon that already existed while contributions were open constrains nobody.

### 4. The verifying key in the repository is the one this produces

```bash
snarkjs zkey export verificationkey payment_final.zkey vk-check.json
diff <(jq -S . vk-check.json) <(jq -S . ../circuits/build/payment_vk.json)
```

An identical verifying key is the link between the ceremony and what actually
gates money on chain. If they differ, the deployed verifier is not this
ceremony's output, whatever the transcripts say.

### 5. Optional: the circuit is the circuit

Everything above verifies the setup for *a* constraint system. To check it is
the one in this repository:

```bash
cd circuits
npm run build -- --no-zkey
snarkjs r1cs info build/payment.r1cs
```

Compare the constraint counts against
[circuits/README.md](../../circuits/README.md), which records them alongside the
measured change from the circuit this was ported from. `npm test` then runs the
suite, including the forged-weekday attack that the time rule has to reject.

---

## If a check fails

Say so in public before saying so to us. A ceremony whose problems are reported
privately and fixed quietly is not a public ceremony. Open an issue on
[wienerlabs/square](https://github.com/wienerlabs/square/issues) with the
command you ran and its output.

Until every check above passes against published files, the setup is a
development setup and this repository describes it that way — see
[docs/disclosure/zk-setup-status.md](../disclosure/zk-setup-status.md).
