# Who a receivable may be sold to

**Status:** decided and implemented for [#30][i30].

[i27]: https://github.com/wienerlabs/square/issues/27
[i29]: https://github.com/wienerlabs/square/issues/29
[i30]: https://github.com/wienerlabs/square/issues/30
[i16]: https://github.com/wienerlabs/square/issues/16
[i178]: https://github.com/wienerlabs/square/issues/178

## The gap

Until #30, `ClaimMarket.buy` refused only the seller, the provider and the
client. Any other wallet could buy a receivable. The money leaving escrow
passed the compliance gate of [#27][i27]; the party it was redirected to passed
nothing.

The gap has a concrete cost, not only a conceptual one. The poster's policy
can block a recipient: rule 4 of `payment.circom` checks the recipient against
`blocked_addresses`. A blocked address could buy the receivable, pay the
seller, and then have the release refused. The proof names a blocked
recipient, so the verdict is a split to the client
([hook-failure-modes.md](hook-failure-modes.md)), and the buyer loses the
price it paid. The gate belongs at the purchase, before any money moves.

## The decision: an approved-buyer list, owned by the poster's policy

The issue left one question open: does buyer eligibility bind to an approved
buyer list, or to a separate buyer policy? It binds to **an approved-buyer
list that is part of the poster's policy**. That list sits in `PolicyRegistry`
beside the poster's commitment, keyed by `msg.sender` like `setPolicy`, and no
owner path reaches anyone else's list.

A sale redirects the poster's money, and the poster's policy already judges
who that money may reach, at release. A separate buyer policy, whether the
market's or an operator's, would be a second authority over the same question.
It could disagree with the first: a buyer it approves could still be one the
poster's policy blocks, and that is the loss described above. With the list
here, one party decides both.

What this does not do: the list and the circuit's `blocked_addresses` are two
pieces of data the poster maintains, and nothing on chain checks that they
agree. The circuit could take the list as an input, but that changes the
proving key, which [#16][i16] is about to replace by ceremony, and it is not
needed for an ineligible buyer to be refused. So the poster keeps the two
consistent.

## How the list is written: a root of salted leaves

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(buyer, salt))))
root = Merkle root over the leaves, pairs hashed in sorted order
```

Only `root` is stored, through `PolicyRegistry.setBuyerRoot`. A buyer passes
its `salt` and its path to `buy`, and the market rebuilds the leaf from
`msg.sender` and checks it with OpenZeppelin's `MerkleProof`.

| Considered | Why not |
|---|---|
| A plain allowlist, a mapping or an array | Writes every approved counterparty in the clear: who the poster deals with. Fails the third criterion by construction. |
| A root of unsalted leaves, `keccak256(buyer)` | A purchase publishes the path, and the path holds the other members' leaves. Anyone can hash a suspected address and look for it. |
| A zero-knowledge membership proof | It would hide which leaf is the buyer's. But the buyer's address reaches the chain regardless: the price is paid from it, and the kernel pays the face value to it. So a ZK proof hides nothing the salted path does not already hide, and it costs a second circuit, a second proving key with its own ceremony, and a pairing check on every purchase. |

## What reaches the chain

| When | Written | Not written |
|---|---|---|
| `setBuyerRoot` | one storage slot holding the root; `BuyerRootCommitted(poster, root)` | the addresses, how many there are, who stands behind them |
| `buy` | the buyer's own salt and a path of salted hashes, in calldata; `listing.buyer`; `ClaimBought(jobId, buyer, seller, price)` | the other members; who the buyer is |

"The buyer's identity is not written" has a precise meaning here. The address
cannot be withheld, because it pays and it is paid. What stays off chain is who
stands behind that address, which is the record the poster approved it
against, held with the salt, and who else the poster approved. The path length
does give away a lower bound on the list's size: a path of k hashes means more
than 2^(k-1) members.

Both rows are measured, not argued:

- `test_privacy_publishingAListWritesTheRootAndNothingElse` records every write
  and every log of `setBuyerRoot`: one slot, holding the root, and one event
  carrying the poster and the root.
- `test_privacy_aPurchaseRevealsNoOtherMember` checks that the other members
  are present in the path under their salts, and absent under every guess
  available without them.

## Semantics

- **No list approves nobody.** A zero root means no buyer is approved. So does
  a poster that never wrote a root: its receivables cannot be sold. This fails
  closed, for the reason a zero `dailyLimit` authorises no spending.
- **Judged at the purchase.** Replacing the list later does not undo a sale.
  From then on, what matters is the proof at release, bound to the payee by
  [#27][i27].
- **A path belongs to the address it was issued to.** A buyer's salt and path
  are public once its transaction is broadcast. The leaf is rebuilt from
  `msg.sender`, so they prove nothing for anyone who copies them.
- **Salts are the poster's secret.** They are 32 bytes from the platform's
  CSPRNG. The SDK refuses a salt below 2^128, the floor [#178][i178] set for
  `policy_salt`. A poster who loses the salts issues a new list: new salts, a
  new root.
- **Three builders, one tree.** The contract verifies with OpenZeppelin's
  library. `test/BuyerLists.sol` builds trees independently of it, and
  `@squaresdk/core`'s `buyers.ts` builds them a third time. The anvil suite
  reads `ClaimMarket.buyerLeaf` from the chain and compares it with the SDK's
  leaf.

## The release, when the payment goes to the buyer

The proof has to answer "who is this payment going to" correctly. Public
signal 2 is bound to `payeeOf(jobId)`, which is the buyer once a receivable is
sold ([#27][i27], [#29][i29]). Two tests against real proofs pin both
directions:

- `test_soldClaimBindsToTheBuyer`: a proof naming the seller, on a sold
  receivable, is refused, and the buyer is not paid by it.
- `test_soldClaimReleasesToTheBuyerTheProofNames`: the prover's proof for a
  payment to `0x1111…1111`, on a receivable that address bought. It releases
  to the buyer, the client gets nothing back, and the client's daily counter
  advances by the amount.

## Cost

Measured on anvil by `npm run lifecycle`, with a list of one:

| Call | Gas |
|---|---|
| `setBuyerRoot` | 28,484 |
| `buy`, eligibility included | 108,217 |

The path grows by one hash per doubling of the list.

## On Arc

Not redeployed. The market at `0x54cd…1a36` still has the previous `buy`,
without the gate and without a registry. The new constructor and the new
`buy` need `contracts/script/deploy-arc-testnet.sh`, run by the holder of the
deployer key. That key is not on the machine this was built on. Until the
redeploy, the SDK's `buyClaim` does not match the market on chain 5042002.
The app reads the client's root through the market, and the read reverts
against the old market (checked against chain 5042002), so the job page says
that no list can be read and does not offer the purchase. The page keeps
working.
