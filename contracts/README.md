# Contracts

The settlement layer: an ERC-8183 job escrow on Arc, settled in the USDC ERC-20
interface, with an optimistic evaluator, bonded arbitration, a receivable market
and one whitelisted hook that routes payouts, runs the compliance check and
writes ERC-8004 reputation.

| Contract | Role | Design |
|---|---|---|
| `SquareJob` | ERC-8183 kernel: lifecycle, escrow, fee snapshot, pull-payment ledger, hook whitelist | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `KeeperEvaluator` | evaluator seat: challenge window, permissionless finalize, keeper fee, dispute entry | [keeper-economics.md](../docs/design/keeper-economics.md) |
| `Arbitration` | bonded disputes, versioned M-of-N arbiter set, bitmask votes, bond routing | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `ClaimMarket` | list, buy, cancel the receivable; `payeeOf` for the kernel | [storage-and-events.md](../docs/design/storage-and-events.md) |
| `SquareHook` | the hook: agent binding, payout routing, compliance slot, reputation and validation writes | [square-hook.md](../docs/design/square-hook.md) |

## Commands

```bash
forge build
forge test
forge test --gas-report
```

Foundry 1.3 with `solc 0.8.28`, Cancun. Dependencies are git submodules under
`lib/` (`forge-std`, `openzeppelin-contracts` v5.7.0); clone with
`--recurse-submodules` or run `git submodule update --init`.

## Local stack

```bash
anvil --port 8545 --chain-id 31337
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`DeployLocal` deploys an EIP-3009 USDC mock and mock ERC-8004 registries, then
the five contracts wired the same way as on Arc, and writes
`deployments/31337.json`. Anvil's default accounts are the actors: 0 deploys and
owns, 1 is the client, 2 the provider (owner of mock agent 1), 3 the buyer,
4 to 6 the arbiters. `@squaresdk/core`'s anvil test runs the whole lifecycle
against it.

## Arc Testnet

```bash
set -a; source ~/.square/arc-testnet-deployer.env; set +a
export ARC_RPC_URL=https://rpc.testnet.arc.io
export USDC_ADDRESS=0x3600000000000000000000000000000000000000
export IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
export REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
export VALIDATION_REGISTRY=0x8004Cb1BF31DAf7788923b405b754f57acEB4272
export ARBITERS=<addr>,<addr>,<addr> ARBITER_THRESHOLD=2
export CHALLENGE_WINDOW=120 DISPUTE_WINDOW=300 FINALIZE_GRACE=600
forge script script/DeploySettlement.s.sol --rpc-url "$ARC_RPC_URL" --broadcast
```

`script/deploy-arc-testnet.sh` does the same with the testnet defaults above,
reading the deployer and the actor set from `~/.square/*.env`. The redeploys are recorded in `docs/deploy/redeploy-<date>.md`, the latest being
[docs/deploy/redeploy-2026-09-09.md](../docs/deploy/redeploy-2026-09-09.md).

Every parameter is an environment variable with a documented default
(`script/DeploySettlement.s.sol`); nothing is hard-coded. The script writes
`deployments/<chainId>.json`, which `@squaresdk/core` embeds.
`MIN_REPUTATION_BUDGET` (default 1 USDC) is the smallest budget for which the
hook writes positive ERC-8004 feedback; the trusted evaluator for that feedback
is the `KeeperEvaluator` the script deploys.

Ownership is offered, not passed. When `OWNER` differs from the deployer the
script calls `transferOwnership(OWNER)` on `SquareJob`, `KeeperEvaluator`,
`Arbitration` and `SquareHook`, and all four are `Ownable2Step`: the deployer
stays the owner until `OWNER` calls `acceptOwnership()` on each of them. Until
that second step the deployer can still whitelist hooks, move the fee treasury
and install a compliance module, so the accept calls belong in the same
runbook as the deploy, and the deploy log prints the reminder.

## Superseding a deployment

The full checklist, including the documents a redeploy makes stale and the
two places that carry the addresses, is
[docs/deploy/README.md](../docs/deploy/README.md). A redeploy leaves the
previous contracts on chain with their balances. Before the old addresses are
dropped from the SDK and the docs:

1. Finalize or reject every job still `Submitted` on the old `KeeperEvaluator`
   (`finalize` is permissionless), so no escrow stays in the old kernel.
2. Have every account with `withdrawable(account) > 0` on the old `SquareJob`
   and the old `Arbitration` call `withdraw()`; the deploy record lists the
   accounts that did and the balances that remain claimable.
3. Record the transactions in `docs/deploy/redeploy-<date>.md`.

A dry run against a fork of the testnet with the real ERC-8004 registries is
`packages/core/test/fork.test.ts`. It escrows an EIP-3009 mock instead of the
real USDC because the ERC-20 interface at `0x3600...0000` moves native balances
through a system path anvil cannot execute; the reputation and validation writes
land on the deployed registry implementations and are read back from them.

```bash
anvil --port 8546 --chain-id 5042002 --fork-url https://rpc.testnet.arc.io
cd packages/core && ARC_FORK_RPC_URL=http://127.0.0.1:8546 npm test
```

## Deployed settlement stack

| | |
|---|---|
| Network | Arc Testnet (`5042002`) |
| `SquareJob` | [`0x76E8690cEa9d94df810eE6b1F453866f0ee68c7B`](https://testnet.arcscan.app/address/0x76E8690cEa9d94df810eE6b1F453866f0ee68c7B) |
| `KeeperEvaluator` | [`0x08100b5211463861f26aC8Bc73Df32A8A2f6ebbD`](https://testnet.arcscan.app/address/0x08100b5211463861f26aC8Bc73Df32A8A2f6ebbD) |
| `Arbitration` | [`0x1c6Be0d4a84a8F0770341269393EaB13098866C2`](https://testnet.arcscan.app/address/0x1c6Be0d4a84a8F0770341269393EaB13098866C2) |
| `ClaimMarket` | [`0x54cd26490dF9212DC6187C73CC07132cd39A1a36`](https://testnet.arcscan.app/address/0x54cd26490dF9212DC6187C73CC07132cd39A1a36) |
| `SquareHook` | [`0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6`](https://testnet.arcscan.app/address/0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6) |
| Parameters | challenge window 120 s, dispute window 300 s, evaluator fee 50 bp, platform fee 100 bp, bond 1000 bp with a 1 USDC floor, 3 arbiters, threshold 2 |
| Deployment file | `deployments/5042002.json`, embedded in `@squaresdk/core` |

The windows are testnet values chosen so the acceptance run finishes in minutes;
production values are days. The run itself, with every transaction and its gas,
is [docs/deploy/lifecycle-5042002.md](../docs/deploy/lifecycle-5042002.md).

## Measured gas

[docs/deploy/gas.md](../docs/deploy/gas.md).

## Groth16 verifier

The compliance half of the tree, from #17. Kept verbatim below.

Foundry project. The on-chain half of the compliance gate.

```
src/Groth16Verifier.sol      the pairing check, written here under Apache-2.0
test/Groth16Verifier.t.sol   against proofs the prover service produced
test/fixtures/proofs.json    those proofs — regenerated, not hand-written
script/Deploy.s.sol          verifier deployment
script/DeploySettlement.s.sol settlement stack deployment (see above)
script/DeployLocal.s.sol     local stack with mocks
script/verify-on-arc.mjs     verify a proof against Arc, no deployment needed
script/regenerate-fixtures.mjs
script/verifier-constants.mjs   verifying-key constants from verification_key.json (for #16)
```

```bash
forge test
node script/verify-on-arc.mjs
```

## The verifier

`src/Groth16Verifier.sol` implements the Groth16 verification equation over
BN254 directly on the chain's precompiles (`0x06` add, `0x07` scalar
multiplication, `0x08` pairing): the eight public signals are range-checked
against the scalar field, folded into the linear combination of the verifying
key's `IC` points, and the four pairings `e(-A, B) e(alpha, beta) e(L, gamma)
e(C, delta)` are checked to multiply to one. Malformed input returns `false`
rather than reverting. It replaced the contract snarkjs generates, which carries
that tool's GPL-3.0 licence; the reasoning is in
[docs/decisions/groth16-verifier-license.md](../docs/decisions/groth16-verifier-license.md).
The verifying key constants are data from the trusted setup and are regenerated
with `script/verifier-constants.mjs`.

**The ceremony is not the only thing that invalidates them.** Any change to
`payment.circom` or to what it includes changes the constraint system, and a
verifier from the old key rejects every proof from the new circuit. Regenerate
the constants **and** `test/fixtures/proofs.json` together, from the same key —
they are the two halves of one artifact, and `_provenance.zkey_sha256` in the
fixtures records which key that was.

`script/check-verifier-ic.mjs` catches the case where somebody forgets. It runs
in `circuits.yml` against the key that job just built and compares `IC0..IC8`,
the only constants derived from the circuit rather than from the powers of tau.
Regenerating the fixtures alone turns `forge test` red, which is loud; changing
the circuit and regenerating **neither** used to leave everything green, which
was not.

It replaces 2,407 lines of Rust. `alt_bn128` is EVM's bn128, so the pairing the
Solana verifier reached through syscalls is the precompiles here, all three
confirmed live on Arc.

```solidity
function verifyProof(
    uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
    uint[8] calldata pubSignals
) public view returns (bool)
```

Eight public signals, in the order
[`circuits/README.md`](../circuits/README.md) documents. The verifier reads them
positionally, so that order is a contract between the circuit, the prover and
this file.

### The proof encoding

The prover emits exactly these four arguments in its `solidity` field. The
Solana encoding it replaced negated `pi_a`'s Y coordinate and reordered `pi_b`'s
Fp2 limbs for arkworks; this verifier negates internally and wants neither.
Getting that wrong produces a proof that silently fails to verify rather than a
wrong answer, so the prover's encoding is checked against `snarkjs zkey export
soliditycalldata` in `services/prover/test/solidity-encoding.test.js`.

### Verification is not authorisation

`is_compliant` is one of the eight signals, not a precondition. A non-compliant
payment still produces a proof that verifies — the circuit proves the six checks
*ran*, not that they passed. `test_acceptsANonCompliantProof` asserts this
rather than leaving it looking like a gap.

Refusing to release on `is_compliant = 0`, and checking that the other seven
signals describe the job actually being settled, is the hook's job in
[#27](https://github.com/wienerlabs/square/issues/27). A proof that verifies but
is not bound to a job is a proof of somebody else's payment.

## Deployed

| | |
|---|---|
| Network | Arc Testnet (`5042002`) |
| `Groth16Verifier` | [`0x35d7B65BDDf5C19DE107B1f90110B1FB381F7Ae1`](https://testnet.arcscan.app/address/0x35d7B65BDDf5C19DE107B1f90110B1FB381F7Ae1) — **superseded**, see below |
| Deployment tx | [`0xc16ff2be…`](https://testnet.arcscan.app/tx/0xc16ff2be8a7a460d4bafac577bcf863b29d673306e7c89083695ec5cd5995c20) |
| Block | 60,844,632 (2026-09-07) |

**That deployment is superseded and is not being replaced.**
[#119](https://github.com/wienerlabs/square/issues/119) added two range checks to
`payment.circom`, which changed the constraint system, which changed the key,
which changed 22 of the 32 constants in this file — the four `DELTA` values and
all eighteen `IC` coordinates. `ALPHA`, `BETA` and `GAMMA` did not move: they
come from the powers of tau and from a fixed generator, not from the circuit.
The contract at that address now rejects every proof this repository produces,
which is the correct behaviour and the reason a stale verifier fails loudly
rather than quietly.

Redeploying would not help. `circuits/scripts/build.mjs` draws fresh phase-2
entropy on every build, so a verifier deployed today is already wrong for
tomorrow's build; every deployment before the ceremony has a lifetime of one
`npm run build`. [#16](https://github.com/wienerlabs/square/issues/16) fixes one
key, and that is the one worth an address. Until then
`script/verify-on-arc.mjs` with no `--address` puts this contract's bytecode on
Arc for a single `eth_call` — the real chain and the real precompiles, keyed to
the build in front of you. See
[docs/disclosure/zk-setup-status.md](../docs/disclosure/zk-setup-status.md).

## Measured cost

From transaction receipts on Arc, not estimates and not local simulation.

| | Gas | Cost at 22.17 gwei |
|---|---|---|
| **Deployment**, on chain | **714,837** | 0.01585 USDC |
| **One verification**, on chain (`eth_estimateGas`, whole call) | **281,596** | 0.00624 USDC |
| **One verification**, execution only (Foundry) | **258,232** | 0.00573 USDC |

[Verification tx](https://testnet.arcscan.app/tx/0x2a2e637745599c19152a032d8fa5d65dbc910e993e09d766c9019a4f592d6d14)
— `verifyProof` is a `view` function, so this is a transaction sent to it purely
to get a receipt with a real `gasUsed`.

How that compares to what was measured off chain:

| Measurement | Gas |
|---|---|
| Arc receipt, whole transaction | 262,403 |
| Arc `eth_estimateGas` | 265,653 |
| Local: 21,000 base + calldata + execution | 269,384 |
| Local: `verifyProof` execution alone | 242,432 |

The local deployment figure was 486,154 and the chain charged exactly that. The
estimate ran 3,250 gas over what the transaction actually used, which is what an
estimate is for.

The report this work started from estimated 250–265k for a verification. The
measurement is 262,403.

Reproduce:

```bash
forge test --match-test test_gas_verifyProof -vv                  # local
node script/verify-on-arc.mjs   # state override; --address needs a verifier built from the same key
```

That is the pairing alone. What a compliance-gated release costs end to end —
the hook, the counter, the transfer — belongs in
[#28](https://github.com/wienerlabs/square/issues/28).

## Verifying against Arc without deploying

```console
$ node script/verify-on-arc.mjs
rpc      https://rpc.testnet.arc.io
chain id 5042002
block    60815572

verifier state override at a scratch address (nothing deployed)

a proof the prover service produced
  ok    compliant proof verifies
  ok    non-compliant proof also verifies — is_compliant is a signal, not a gate

tampering is rejected
  ok    flipped is_compliant
  ok    altered amount

Arc gas for one verification: 265653

All checks passed against Arc.
```

"It verifies in Foundry" and "it verifies on Arc" are different claims. The
first says the contract is right; the second says Arc's precompiles agree with
revm's, which is the one #17 asks for and the one nobody should take on trust.
An `eth_call` state override gets it without a funded account: the node runs the
real bytecode against the real precompiles for one call.

Pass `--address 0x…` to point it at a deployed verifier instead.

## Redeploying

After the ceremony, or after any change to the circuit:

```bash
export ARC_RPC_URL=https://rpc.testnet.arc.io
forge script script/Deploy.s.sol --rpc-url "$ARC_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
node script/verify-on-arc.mjs --address <deployed address>
```

Needs a funded Arc testnet account; Arc pays gas in USDC, and a deployment costs
about 0.011 USDC at current prices. Testnet USDC comes from
[faucet.circle.com](https://faucet.circle.com).

Regenerate `src/Groth16Verifier.sol` from the new key first — the contract is
`snarkjs zkey export solidityverifier` output and a verifier from the old key
will reject every proof from the new one.

## Fixtures

`test/fixtures/proofs.json` holds real `POST /prove` responses, not values
written for the test. A verifier checked against proofs invented alongside it
shows that the test and its author agree; the property worth having is that what
the prover emits is what the chain accepts.

Regenerate after any change to the circuit, the proving key or the encoding —
all three invalidate them, and a stale fixture fails loudly, because a proof for
a different circuit does not verify:

```bash
PROVER_ARTIFACTS_DIR=/path/to/artifacts node script/regenerate-fixtures.mjs
script/verifier-constants.mjs   verifying-key constants from verification_key.json (for #16)
```
