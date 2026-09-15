# Funding a job with USDC from another chain (CCTP V2)

**Status**: built and measured up to Arc's door (square#32). The burn runs
against Circle's real contracts on a fork of Ethereum Sepolia, the message
layout is checked against a real attested transfer, and a message Arc has
already minted is read as such from the live chain. The run that crosses
for real, source testnet to Arc to escrow, needs a funded key on each side
and writes `docs/deploy/cctp-<date>.md`; it has not been run yet.

## What it is

An institution whose USDC sits on Ethereum, Base or Arbitrum funds a Square
job on Arc without a bridge of anyone else's. Circle's Cross-Chain Transfer
Protocol burns the USDC where it is and mints the same USDC on Arc, against
an attestation Circle signs; the minted USDC is an ordinary Arc balance and
`SquareClient.fund` takes it from there.

Three transactions, three hands:

| Step | Where | Who | What |
|---|---|---|---|
| `depositForBurn` | the source chain's `TokenMessengerV2` | the source wallet | burns the amount for Arc (domain 26), naming the recipient and the most the attester may take |
| attestation | `https://iris-api-sandbox.circle.com` | Circle | signs the message once the burn is final enough for the finality asked |
| `receiveMessage` | Arc's `MessageTransmitterV2` | anyone holding the attestation, here the Arc wallet | the `TokenMinterV2` mints to the recipient, less the fee |
| `createJob`, `setBudget`, `fund` | Arc's `SquareJob` | the Arc wallet | the ordinary funding, with what was minted |

## The constants, read back

Nothing here is from a page alone. On 2026-09-15:

- The three contracts sit at the same addresses on every EVM testnet, Arc
  Testnet included: `TokenMessengerV2` `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`,
  `MessageTransmitterV2` `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`,
  `TokenMinterV2` `0xb43db544E2c27092c107639Ad201b3dEfAbcF192`; all three
  have code on Arc (`eth_getCode`).
- Arc's transmitter answers `localDomain() == 26` and `version() == 1`; its
  messenger's `messageBodyVersion() == 1` and `localMinter()` is the minter.
- The minter maps the three source USDCs to Arc's `0x3600…`:
  Ethereum Sepolia (domain 0) `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`,
  Base Sepolia (domain 6) `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
  Arbitrum Sepolia (domain 3) `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
  (`getLocalToken(domain, token)`), and each source messenger's
  `remoteTokenMessengers(26)` is Arc's messenger.
- The attestation service quotes, for Ethereum Sepolia to Arc,
  `GET /v2/burn/USDC/fees/0/26` → 1 bps at finality 1000 (Fast Transfer),
  0 bps at finality 2000 (Standard Transfer). A burn of 0.5 USDC at fast
  finality therefore carries `maxFee` 0.00005 USDC.
- A hash the service has not seen answers 404 `Message not found for
  provided parameters`; a complete one answers `messages[0]` with `message`,
  `attestation`, `eventNonce`, `status: "complete"`, `cctpVersion: 2`,
  `decodedMessage` and `destinationMintTxHash`.

## The message

`MessageV2.sol` and `BurnMessageV2.sol` lay the bytes out at fixed offsets;
`decodeCctpMessage` reads them and `test/fixtures/cctp-sepolia-to-arc.json`
is a real attested transfer with Circle's own decoding beside the bytes:

| Field | Offset | In the `MessageSent` event | Once attested |
|---|---|---|---|
| version, source domain, destination domain | 0, 4, 8 | 1, 0, 26 | same |
| nonce | 12 | zero | assigned by Circle; what `usedNonces` is keyed by |
| sender, recipient | 44, 76 | the two messengers | same |
| destination caller | 108 | zero unless the burn named one | same |
| min finality threshold, finality executed | 140, 144 | 1000, 0 | 1000, 1000 |
| body: burn token, mint recipient, amount, sender | 148 + 4, 36, 68, 100 | as burned | same |
| body: max fee, fee executed, expiration block | 148 + 132, 164, 196 | max fee, 0, 0 | max fee, what was charged, the block the attestation lapses at (a day ahead, written by the attester and respected by the destination) |

So the copy to deliver on Arc is the attested one, never the event's: the
event's carries no nonce and no fee.

## The SDK

`@squaresdk/core` exports the three steps and their composition:

```ts
import { bridgeUsdcToArc } from "@squaresdk/core";

const { burn, attestation, receive } = await bridgeUsdcToArc({
  publicClient: sepolia, walletClient: sepoliaWallet,     // the source: its chain id names the domain
  arc: { publicClient: arc, walletClient: arcWallet },
  amount: parseUnits("5", 6),
  recipient: institution,                                 // default: the source wallet's own address
  finality: "fast",                                       // or "standard"; maxFee defaults to what the service quotes
  onEvent: (e) => console.log(e.type),                    // burned, attestation-pending, attested, received
});
```

- `depositForBurn` approves the messenger when the allowance is short, then
  burns; it refuses before sending an amount the messenger refuses (1 unit or
  less), a `maxFee` not below the amount, a chain with no domain, and Arc as
  the source. It hands back the event's message, decoded.
- `waitForAttestation` polls `/v2/messages/{domain}?transactionHash=…` until
  `complete`, reporting each status and the `delayReason` when there is one;
  `fetchAttestation` is one look. A timeout names the hash to try again with.
- `receiveMessage` reads `usedNonces(nonce)` first: a message someone else
  delivered is reported (`alreadyReceived`), not sent again; otherwise it
  delivers and reads `MintAndWithdraw` for what was minted and what the fee
  took.
- `cctpFees` and `maxFeeFor` turn the service's basis points into a `maxFee`.

## Failure and recovery

| Where it stops | What holds the money | What to do |
|---|---|---|
| Before the burn: the amount cannot carry the fee, the allowance transaction reverts | the source wallet, untouched | fix the amount; nothing was burned |
| After the burn, before the attestation: the service is down, the process died | the burn is on the source chain, the USDC is gone from it and not yet on Arc | `waitForAttestation` with the burn's hash, or `BRIDGE_RESUME_HASH=<hash> npm run bridge`; the attestation is there as long as the message has not expired |
| A Fast Transfer whose `maxFee` is below the fee the attester wants | the burn, attested only at standard finality | the status stays `pending_confirmations` with `delayReason`; it completes at the source chain's hard finality, ~15 minutes on Ethereum |
| After the attestation, before the mint: the Arc wallet has no gas, the RPC failed | the attestation, in the service's answer | `receiveMessage` again with the same message and attestation; `usedNonces` makes a second delivery a no-op |
| Someone else delivered it first (a relayer, a second run) | the recipient's Arc balance, already | `receiveMessage` reads `usedNonces` and sends nothing; go on to `fund` |
| The mint succeeded, the funding failed | the recipient's Arc balance | `fund` as for any job; the bridge is done |

An attestation that lapsed unminted (`expirationBlock`, a day after signing)
is not lost while the burn is on the source chain: `reattest(nonce)` asks
Circle for a new one (`POST /v2/reattest/{nonce}`; the sandbox answered
`Re-attestation successfully requested for nonce.` on 2026-09-15), then
`waitForAttestation` with the burn's hash again, then `receiveMessage`
before the new block passes.

## The runner

```bash
BRIDGE_SOURCE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
BRIDGE_SOURCE_PRIVATE_KEY=0x… ARC_PRIVATE_KEY=0x… BRIDGE_AMOUNT=1 npm run bridge     # in packages/core
```

`packages/core/scripts/bridge.ts` bridges the amount, delivers it on Arc,
creates a job with the Arc wallet as client and provider, funds it with what
was minted, and writes `docs/deploy/cctp-<date>.md` with every hash linked
to its explorer. `BRIDGE_JOB=none` stops at the mint; `BRIDGE_RESUME_HASH`
starts from a burn already sent. The source wallet needs the USDC and the
chain's gas (Circle's faucet at `faucet.circle.com` hands out testnet USDC);
the Arc wallet needs Arc gas, which is USDC.

## Evidence

| What | Where | Result |
|---|---|---|
| The header and the burn body of a real attested Sepolia → Arc transfer decode field for field as Circle decodes them; a header alone has no burn body; addresses pad and unpad; the four domains; the fee arithmetic | `packages/core/test/cctp.test.ts` | 19 tests, hermetic |
| The attestation service scripted from its real answers: fees, not-found → pending → complete, the timeout naming the last status, a 500 is an error, `reattest` posts the nonce | same file | in the 19 |
| `depositForBurn` against a fake chain: approval only when short, the exact arguments (domain 26, padded recipient, the domain's USDC, no caller, the quoted fee, the finality), the four refusals, the missing event | same file | in the 19 |
| `receiveMessage`: reads the nonce first, sends nothing for a used one, decodes the mint | same file | in the 19 |
| The burn against Circle's real `TokenMessengerV2` on a fork of Ethereum Sepolia: 2 USDC borrowed from a recent recipient, burned for an Arc address, `DepositForBurn` for domain 26 with the arguments given, the transmitter's message decoded with a zero nonce and zero fee executed | `packages/core/test/cctp.fork.test.ts`, `CCTP_SEPOLIA_FORK_RPC_URL` | 1 test, 109 091 gas for the burn |
| A message Arc minted on 2026-09-15 read as already received from the live chain, nothing sent | same file | 1 test |
| The runner on the fork: quotes the fees, burns 0.5 USDC at `maxFee` 0.00005, polls the service, and stops naming the hash when the service cannot know a fork's transaction | `npm run bridge` with `BRIDGE_ATTESTATION_TIMEOUT_MS=12000` | as described |

What is not shown: an attestation for a burn of ours, and the mint and the
funding on Arc. Both need a funded key on a source testnet and one on Arc,
and both are one `npm run bridge` away.
