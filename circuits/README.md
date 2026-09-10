# Circuits

The payment-compliance circuit and the scripts around it.

```
payment.circom              the circuit
lib/timestamp.circom        UTC decomposition, soundly constrained
test/                       vitest suites and the circuits they drive
scripts/build.mjs           compile, and produce a development proving key
scripts/fetch-ptau.mjs      fetch and hash-check the adopted phase-1 ceremony
scripts/inspect-zkey-setup.mjs   read a zkey's trusted-setup provenance
```

> The proving key `scripts/build.mjs` produces has a **real phase 1** — the
> adopted Perpetual Powers of Tau contribution 80, verified by hash and recorded
> in [docs/ceremony/phase1-ptau.md](../docs/ceremony/phase1-ptau.md) — and a
> **development phase 2**: one contribution from your own machine, no beacon. It
> stays a development key until [#16][i16] runs the phase-2 ceremony, and
> nothing built on it carries an assurance claim. See
> [docs/disclosure/zk-setup-status.md](../docs/disclosure/zk-setup-status.md).

## Public signals

Eight, in this order. The verifier reads them positionally, so the order is part
of the contract between this circuit, the prover service and the on-chain
verifier. Changing it is a breaking change that needs a new ceremony.

| # | Signal | Meaning |
|---|---|---|
| 0 | `is_compliant` | `1` when all six rules pass, `0` otherwise. |
| 1 | `policy_data_hash` | Commitment to the whole policy, openable one field at a time. The hook compares it against the registry. See [The policy commitment](#the-policy-commitment). |
| 2 | `recipient` | Payee address as a field element. The hook compares it against the job's provider. |
| 3 | `amount` | Payment amount in USDC base units, 6 decimals. Compared against the job's net payment. |
| 4 | `token` | Token address as a field element. |
| 5 | `daily_spent_before` | The operator's spend for the day before this payment. Compared against the counter. |
| 6 | `current_unix_timestamp` | Seconds. The contract bounds it to `block.timestamp ± tolerance`. |
| 7 | `stripe_receipt_hash` | Poseidon receipt commitment, `0` when no Stripe receipt is claimed. |

A proof that verifies says only that the six checks were *performed* on these
values. `is_compliant = 0` still produces a valid proof; refusing to release on
a zero is the contract's job, and so is checking that these eight values
describe the job actually being settled. A proof not bound to a job is a proof
of someone else's payment.

### Addresses are one field element

An EVM address is 20 bytes and fits in a BN254 element with room to spare. The
Solana circuit this was ported from split 32-byte pubkeys into `high`/`low`
halves because they exceed the field, which is why there used to be ten public
signals; `recipient_high`/`recipient_low` and `token_mint_high`/`token_mint_low`
collapse to one signal each.

The same change removed the Poseidon hashing of address-list entries. It existed
only to fold two halves into one comparable value; with a single element,
membership is plain equality. Entries in `token_whitelist` and
`blocked_addresses` are now raw address field elements, and the policy
commitment hashes them directly. A commitment produced by the Solana-era backend
will not match this circuit — expected, since the whole layout changed.

Category entries are unaffected: they are strings, 32 bytes does not fit in one
element, and they stay Poseidon images.

### Amounts are 6-decimal ERC-20 units

Rules 1 and 2 compare with `LessEqThan(64)`, so amounts stay under 2^64. At 6
decimals that is roughly 18.4 trillion USDC; at Arc's 18-decimal native
accounting it would be 18.45 USDC and the circuit could not express a normal
payment. Escrow and payment paths therefore use the ERC-20 interface — see
[docs/decisions/erc20-vs-native-usdc.md](../docs/decisions/erc20-vs-native-usdc.md).

The circuit enforces the bound with `Num2Bits(64)` on `amount` and
`daily_spent_before` rather than assuming it. circomlib's comparator constrains
the difference of its operands, not the operands themselves, so without the
range check a field element near the modulus would pass.

## The policy commitment

`policy_data_hash`, public signal 1, is what the registry holds and the hook
compares. Since [#45][i45] it is built so that it can be opened one field at a
time:

```
leaf[i] = Poseidon(3)(i, salt[i], value[i])
root    = Poseidon(8)(leaf[0] … leaf[7])
```

The eight values, in the order they are hashed — the order is part of the
commitment, since `i` goes into its own leaf:

| i | field |
|---|---|
| 0 | `max_daily` |
| 1 | `max_per_tx` |
| 2 | `operator_id` |
| 3 | `policy_id` |
| 4 | `allowed_categories`, as a Poseidon image of the padded list |
| 5 | `blocked_addresses`, likewise |
| 6 | `token_whitelist`, likewise |
| 7 | `time_window`, or `0` when no window is set |

**Selective disclosure.** To prove one field to an auditor, hand over `(i,
value, salt)` and the seven sibling leaves. The auditor recomputes leaf `i`,
recomputes the root, and compares it to
`PolicyRegistry.commitmentOf(institution)`. A disclosure that verifies is a
statement about the policy that institution registered, not about one assembled
for the occasion. `services/prover/src/commitment.js` is the implementation, and
`open()` / `verifyDisclosure()` are the two calls.

**The salts are why this discloses selectively.** Without them the siblings are
Poseidon images of guessable values: `max_daily` is published on chain as
`PolicyRegistry.dailyLimit`, the time field has fewer than 150,000 possible
values, and an empty list has a well-known image. An auditor shown seven
"hidden" siblings could search for six of them over a coffee. That was
[#98][i98], and this construction closes it — `test/disclosure.test.js`
demonstrates the difference rather than asserting it, by finding an unsalted
leaf in a two-thousand-value search and failing to find the salted one.

**The salts come from the caller, not from here.** They derive from one
`policy_salt` the operator keeps with the policy, because a policy has to
produce the same commitment every time it is proved — a salt this circuit or the
prover invented would change the commitment on every call and never match the
registry. They are unconstrained private inputs; what pins them is that a
different salt is a different commitment, and the registry holds one.

**The index is inside the leaf**, so a leaf cannot be replayed in another
position. Aperture's tree, which this replaces, sorted each pair before hashing
and so discarded position entirely, hashed leaves and internal nodes the same
way — letting an internal node be presented as a leaf — and duplicated the last
leaf on an odd count, which lets two different leaf sets share a root. None of
those apply here: one level, position inside the leaf, and a leaf is a
`Poseidon(3)` while the root is a `Poseidon(8)`.

[i45]: https://github.com/wienerlabs/square/issues/45
[i98]: https://github.com/wienerlabs/square/issues/98

## The six rules

| Rule | Check | Private inputs it reads |
|---|---|---|
| 1 | `amount <= max_per_tx` | the per-transaction ceiling |
| 2 | `daily_spent_before + amount <= max_daily` | the daily ceiling |
| 3 | `token` is on the whitelist | the whitelist |
| 4 | `recipient` is not on the blocked list | the blocked list |
| 5 | `payment_category` is allowed | the category list |
| 6 | the timestamp falls inside the policy's window | `time_active`, the weekday bitmask, the start and end hours |

Everything in the right-hand column stays private. An auditor learns that the
checks ran, not what the operator's limits or lists were.

**Rule 6's window cannot cross midnight.** The circuit computes
`hour >= start AND hour <= end`, which is empty whenever `start > end`, so a
policy of 22:00 to 06:00 would put no hour of any day inside the window and
refuse every payment it covers. The prover refuses such a policy instead: since
[#148][i148], `allowed_hours_start > allowed_hours_end` is a 400 whose message
says the window is not modelled, and both hours have to be in 0..23 — the range
the OpenAPI document had declared and nothing enforced. An overnight window is
expressed as two policies, one per side of midnight.

**And it is one window, over at least one day.** The commitment's eighth field
is `time_field = Poseidon(1, days_bitmask, start, end)`, which holds a single
window and has room for exactly one. A request carrying a second
`time_restrictions` entry used to be validated field by field and then dropped
by the builder, which reads only the first — so the policy the caller sent and
the policy the proof covered were different documents. Since [#181][i181] the
service refuses the second entry instead. An empty `allowed_days` is refused
for the same reason as the overnight window: it forbids every weekday, so no
payment could satisfy the rule. Leaving `time_restrictions` out is how a policy
says it has no window at all.

[i148]: https://github.com/wienerlabs/square/issues/148
[i181]: https://github.com/wienerlabs/square/issues/181

### Rule 5 binds nobody, and the reason is structural

**`payment_category` is the operator's own statement about what a payment was
for, and the circuit cannot check it against anything.** Every other rule tests a
value that is either a public signal — rules 1, 2, 3, 4 and 6 read `amount`,
`daily_spent_before`, `token`, `recipient` and `current_unix_timestamp` — or one
committed inside `policy_data_hash`. Rule 5's key is in **neither**. It is a
private input (`payment.circom:95`), it is not among the eight public outputs,
and it is not among the eight Poseidon inputs.

An honest prover fails rule 5 on a disallowed category, and
`test/payment.test.js` asserts that. What rule 5 cannot do is constrain somebody
who builds a witness by hand: nothing outside the circuit ever sees the category,
so nothing can contradict it.

Exposing it as a ninth public signal was considered and **not** done. There is
nothing in the system to compare it against — no category field on chain, no
category parameter in `IComplianceModule.checkRelease`, and the prover receives
the category and the list of allowed categories from the same caller. "What was
this payment for" is inherently the payer's assertion. A public signal nothing
can check costs calldata on every verification and buys a binding that does not
exist.

This is fixed by [#16](https://github.com/wienerlabs/square/issues/16): the
ceremony freezes the circuit, so a ninth signal cannot be added afterwards. The
decision is recorded here rather than left to be discovered from the signal
list. Read rule 5 as "the operator declared a category and it was on their own
list", not as "this payment was for what it says".

## Rule 6 and why it stayed in the circuit

The time window's timestamp decomposition used to be under-constrained: it
witnessed `day_index` and `weeks`, checked the division identities and the
remainders, and bounded neither quotient. Since 7 is invertible in the field, a
prover writing a witness by hand could pick any weekday and solve for the
`weeks` that made the identity hold. The rule enforced nothing.

Moving the rule on-chain was considered and is not possible: the window
parameters are private inputs and reach the chain only inside the Poseidon
commitment. The contract never learns the window, so it cannot judge a timestamp
against it — it can only bound the timestamp against `block.timestamp`, which is
a freshness check, not a policy check. Making the window public would publish
the operator's working hours.

So the rule stays and is constrained properly. `lib/timestamp.circom` carries
the full argument; the short version is that every quotient is now bounded from
above as well as every remainder, which keeps the arithmetic below the modulus
and makes each decomposition unique.

`test/timestamp-soundness.test.js` runs the attack against both the old shape
and the new one. The old template accepts a forged weekday; the new one rejects
it, and rejects it for all six wrong weekdays.

## The list masks, and why they are gone

Each policy list used to arrive with a parallel mask array marking which slots
held real entries. `policy_data_hash` committed to the list *values* and not to
the masks, and nothing else constrained them — so a prover could zero
`blocked_addresses_mask`, leave every value untouched, and hand the contract a
proof whose policy commitment was byte-identical to the honest one while rule 4
matched nothing.

Run against the circuit as it stood, paying an address on the operator's own
blocked list:

```
honest witness (mask intact)
  is_compliant      0
  policy_data_hash  16676072621032020736630513635815524526677413825308518761974603268960007226738

forged witness (blocked mask zeroed, values untouched)
  is_compliant      1
  policy_data_hash  16676072621032020736630513635815524526677413825308518761974603268960007226738

commitment identical in both runs: true
rule 4 bypassed: true
```

The masks were never load-bearing. Padding slots hold zero, and the three values
looked up — `token`, `recipient`, `payment_category` — can never legitimately be
zero, so a padding slot could not match them anyway. The arrays are removed and
the three keys carry an explicit non-zero constraint instead, which costs six
constraints and deletes the bypass along with 28 inputs nothing committed to.

The same pass constrained two other operands the comparators assumed rather than
checked: `time_start_hour_utc` and `time_end_hour_utc` are bounded to five bits,
and `time_active` is forced boolean, since rule 6 switches on it.

## Constraint cost, measured

`circom` output, not estimates:

| Circuit | Non-linear | Linear | Wires |
|---|---|---|---|
| Aperture's original `payment.circom` | 2863 | 4514 | 7441 |
| This `payment.circom` | **2609** | **3977** | **6608** |
| Change | **−254** | **−537** | **−833** |

Attribution, each measured by compiling the variant rather than reasoned about:

| Change | Non-linear |
|---|---|
| Rule 6 constrained properly | **+118** |
| `Num2Bits(64)` on the two amounts | **+128** |
| Non-zero lookup keys, window hour bounds, boolean `time_active` | **+14** |
| Mask arrays removed (28 multiplications) | **−28** |
| Addresses collapsed to one field, list Poseidons dropped | **−486** |
| net | **−254** |

The soundness figure is the difference between the two templates in
`test/circuits/`, compiled standalone: `timestamp_checked` is 166 non-linear
against `timestamp_unchecked`'s 48. The rest are this circuit compiled with and
without the block in question. The net is negative — the port paid for four
soundness fixes and still came out smaller than what it replaced.

## Building and testing

```bash
npm install
npm run build                # compile, fetch the phase-1 ptau, then a dev key
npm run build -- --no-zkey   # compile only, which is all most tests need
npm test
```

`circom` and `snarkjs` must be on `PATH`; `scripts/build.mjs` says so plainly if
they are not. The first full build downloads the adopted powers of tau (19 MB)
and refuses to continue if it does not hash to the adopted file, so a proving
key cannot end up standing on an unidentified tau.

Everything lands in `build/`, which is gitignored — the artifacts are
reproducible and a `.zkey` never belongs in git.

The proof round-trip suite skips when no development key is present, and says
so, rather than passing on nothing. Check what a key you built actually is:

```console
$ node scripts/inspect-zkey-setup.mjs build/payment.zkey
phase-1 ceremony         Perpetual Powers of Tau, contribution 80 (ppot_0080_*)
phase-2 contributions    1
beacon applied           no
```

## What happens next

[#16][i16] runs the ceremony that freezes this circuit. Nothing here may change
after that without invalidating the proving key and requiring the ceremony to be
run again, so [#14][i14] was the last chance to change it. [#18][i18] ports the
prover service to the eight-signal layout, and [#17][i17] generates the Solidity
verifier from the ceremony's key.

[i14]: https://github.com/wienerlabs/square/issues/14
[i16]: https://github.com/wienerlabs/square/issues/16
[i17]: https://github.com/wienerlabs/square/issues/17
[i18]: https://github.com/wienerlabs/square/issues/18
