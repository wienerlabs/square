# Escrow and payment paths use the USDC ERC-20 interface, not native value

**Status:** decided in [#14][i14]. Binds the storage and event design in [#6][i6],
the settlement core in [#20][i20] and the compliance hook in [#27][i27].

[i6]: https://github.com/wienerlabs/square/issues/6
[i14]: https://github.com/wienerlabs/square/issues/14
[i20]: https://github.com/wienerlabs/square/issues/20
[i27]: https://github.com/wienerlabs/square/issues/27

## The decision

Every amount that enters escrow, leaves escrow, or appears in a compliance proof
is denominated in **USDC ERC-20 base units — 6 decimals**. Value moves by
`transfer` / `transferFrom` on the token contract. No settlement path uses native
value transfer.

## Why

### 1. The circuit cannot express 18-decimal amounts

`payment.circom` compares amounts with `LessEqThan(64)`, so an amount must stay
under 2^64 = 18,446,744,073,709,551,616 base units. What that ceiling is worth
depends entirely on which interface the units come from:

| Interface | Decimals | 2^64 in USDC | Verdict |
|---|---|---|---|
| ERC-20 | 6 | ≈ 18.4 trillion | Far beyond any plausible mandate. |
| Native gas accounting | 18 | ≈ 18.45 | Smaller than a single realistic payment. |

An 18-decimal denomination would make the circuit unable to represent a $20
payment. Widening the comparator instead is not free — it is a circuit change,
and after [#16][i16] the circuit is frozen behind a ceremony.

[i16]: https://github.com/wienerlabs/square/issues/16

The circuit now enforces this bound rather than assuming it: `amount` and
`daily_spent_before` each carry a `Num2Bits(64)`. Assuming a bound instead of
constraining it is the exact shape of the Rule 6 soundness bug that #14 also
fixes, so the assumption was made explicit while the circuit was open.

### 2. Native transfers hand control to the recipient

A native value transfer runs the recipient's fallback code, which puts arbitrary
callee code in the middle of a release. In a contract that also advances a daily
spend counter and marks a proof consumed, that is a reentrancy surface we would
have to defend on every path. `transfer` on a token contract does not call back
into the recipient, so the surface does not exist.

This matters more here than in a typical escrow: the release path is the one
gated by a compliance proof, and the counter it updates is what the next proof
binds to. A reentrant call between "proof accepted" and "counter written" would
let one proof pay twice.

### 3. Arc genuinely exposes both, so the choice has to be explicit

On Arc, USDC is the gas token, and the two interfaces really do report different
decimals. Verified against Arc testnet rather than taken from documentation:

```console
$ curl -s -X POST https://rpc.testnet.arc.io -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x3600000000000000000000000000000000000000","data":"0x313ce567"},"latest"]}'
{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000006"}
```

`decimals()` on the USDC contract at `0x3600000000000000000000000000000000000000`
returns 6, and `symbol()` returns `USDC`.

The same balance seen through both interfaces, for one account:

```console
$ # native
$ eth_getBalance(0xd28e402a29287589c20d12cc0a5798559176a842)
150617773871734527766        ÷ 1e18 = 150.617773871734527766 USDC

$ # ERC-20 balanceOf on 0x3600…0000
150617773                    ÷ 1e6  = 150.617773 USDC
```

One balance, two denominations, differing by 10^12. Picking one and writing it
down is the whole point of this document.

## What follows from it

- **Storage (#6).** Amounts are `uint256` holding 6-decimal base units. There is
  room to spare — the circuit's own ceiling is 2^64 — so packing an amount into
  a narrower slot is a reasonable optimisation, but the *unit* is fixed. Any
  field that could be read as wei must not exist.
- **Events (#6).** Event amounts carry the same units. An indexer that reads an
  amount and renders it must divide by 10^6, never 10^18.
- **Settlement (#20).** Funding and release use `transferFrom` and `transfer`.
  A `receive()` or `payable` entry point on the escrow is a bug, not a feature:
  value arriving that way is outside the accounting the proofs bind to.
- **Compliance hook (#27).** The `amount` public signal is compared against the
  job's net payment in the same units, so the hook needs no conversion. If a
  conversion ever appears on that path, the binding is wrong.
- **Fees.** Gas is paid in native USDC by the protocol's own accounting; that is
  unrelated to the escrowed amount and never enters a proof.

## What was considered and rejected

**Native value with a wider comparator.** Raising the circuit to
`LessEqThan(128)` would cover 18 decimals. It costs constraints, and more
importantly it does not address the reentrancy surface — the reason to prefer
ERC-20 is not only the arithmetic.

**Native value with an off-chain scale factor.** Storing 6-decimal units while
moving 18-decimal value means every path carries a conversion, and every
conversion is a place for the proof binding and the transfer to disagree. The
hook's whole job is that they cannot.

**Supporting both.** Two denominations in one escrow means the compliance hook
must know which one a job used before it can compare anything. That is a
discriminator the proof does not carry and would have to be added to the public
signals — another circuit change behind the ceremony.

## Open question for #6

The circuit's ceiling is 2^64 base units. If storage packs amounts into
`uint64`, the two limits coincide exactly and an amount that fits storage always
fits the proof. If storage uses a wider type, the contract has to reject
anything at or above 2^64 before requesting a proof, or the prover will fail
witness generation with a far less clear error. Either is fine; #6 should say
which.
