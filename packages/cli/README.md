# `@squaresdk/cli`

Agent identity on Arc from the terminal: register an agent in the ERC-8004
IdentityRegistry, and resolve the `did:aip` v2 identifier that registration
produces.

```console
$ square login
$ square register --agent-uri https://acme.example/agent.json
$ square resolve did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2
```

## Install

```console
$ npm install && npm run build && npm link
```

`@squaresdk/did-resolver` is linked by path, so build it first:

```console
$ npm --prefix ../did-resolver install && npm --prefix ../did-resolver run build
```

## Commands

| | |
|---|---|
| `square login` | Create or import a secp256k1 wallet, encrypted at rest |
| `square logout` | Delete the local keystore |
| `square whoami` | Address, active network, balance |
| `square register` | Register an agent, print the DID it minted |
| `square resolve <did>` | Resolve a `did:aip` identifier to its DID Document |
| `square config` | Inspect and change the network configuration |

Every command takes `--json`. Machine output goes to stdout and everything else
to stderr, so `square resolve <did> --json | jq` works.

`register --json` writes one JSON record per line rather than one document:
`{"status":"sent", "transactionHash": …}` the moment the RPC accepts the
transaction, then `{"status":"registered", "did": …}` when the receipt arrives,
or `{"status":"reverted", …}` if it reverted. The split exists because
`register` is permissionless and the transaction is out the moment it is sent:
a receipt timeout means "not confirmed yet", not "not registered", and a caller
that never saw the hash could not tell those apart or resolve the question
later. Read the last line for the result, and the first if the command exits
non-zero:

```console
$ square register --agent-uri … --yes --json | tail -n 1 | jq -r .did
```

## The DID is derived, never supplied

`register` does not accept a DID. It sends `register(agentURI)` to the
IdentityRegistry, waits for the receipt, reads the agent id out of the ERC-721
`Transfer` event, and builds the identifier from what actually happened:

```
did:aip:eip155:{chainId}:{registry}:{agentId}
         ^        ^          ^          ^
         |        |          |          the Transfer event in the receipt
         |        |          the registry the transaction went to
         |        the chain the RPC reported
         the only namespace this method defines
```

The id is read from the receipt rather than from the simulated return value
because `register` is permissionless: another registration can land between the
simulation and the mine, and then the predicted id belongs to somebody else. The
CLI says so when that happens rather than printing a DID for an agent it did not
create.

`--dry-run` simulates against the live registry and prints the id it would mint.
It is a read, so it never asks for the passphrase, and `--from <address>` lets it
run with no wallet at all.

A real registration asks for the passphrase last. The card is read, the chain id
checked, the call simulated and the plan printed against the address that will
sign, and the key is unlocked only after the confirmation, so what is reviewed
is reviewed before anything is unlocked.

Registering with no `--agent-uri` uses ERC-8004's no-argument `register()`. That
is a valid registration: the agent exists and is owned, and its DID resolves with
an empty `service` array (method spec §5).

## Network

Arc Testnet is the default and the only chain built in, because it is the only
one whose values were read off the chain rather than out of a document.

| | |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| IdentityRegistry | `0x8004a818bfb912233c491871b3d84c89a494bd9e` |
| Gas | USDC (18 decimals through the native interface) |

Any other chain needs both halves supplied, and the CLI refuses rather than
guessing a registry address:

```console
$ square config set-rpc 12345 https://rpc.example
$ square config set-registry 12345 0x…
$ square config use-chain 12345
```

Overrides, strongest first: command flags, then `SQUARE_CHAIN_ID` /
`SQUARE_RPC_URL` / `SQUARE_REGISTRY`, then `~/.square/config.json`, then the
built-in table. Before it writes anything, `register` checks that the endpoint
reports the chain id it was configured for — a registration cannot be moved
between chains afterwards.

`resolve` takes the chain from the DID, not from the config, so a DID on a chain
you do not register on still resolves as long as an endpoint for it is known.

## The keystore

One secp256k1 private key, encrypted with scrypt (N = 2^17, r = 8, p = 1) and
AES-256-GCM, written atomically to `~/.square/keystore.json` at mode `0600`.
`SQUARE_HOME` moves it.

N = 2^17 costs roughly a second and 128 MiB per attempt. That cost is the point:
it is the only thing between a stolen keystore file and the key inside it.

Two things are checked on every unlock. The GCM tag covers the ciphertext, so a
wrong passphrase and an edited file are both refused — and are indistinguishable,
which is why the error names both. The stored address is *not* covered by the
tag, so it is compared against the address the decrypted key actually derives; a
file that names one signer and hands back another is rejected.

A version-1 keystore from the `aip` CLI is refused by name rather than misread.
The wrapper is byte-identical, so it parses cleanly, but it holds an Ed25519
Solana keypair that cannot sign anything on Arc.

The schema is as tight as the format: a 12-byte IV, a 16-byte tag, a 32-byte
salt and ciphertext, `keyLen` 32, and an scrypt `N` that is a power of two
between 2^14 and 2^18. A file outside that is malformed and says so through the
same door as a file that is not JSON, rather than reaching Node's crypto and
coming back in its words with exit code 1.

Importing an existing key is `square login --import-file <path>`; the shell's
`<(…)` makes a path out of a command without touching the disk. There is no
`--import-key <hex>`: a key on the command line is a key in the process table
and in the shell history, the same exposure `SQUARE_PRIVATE_KEY` warns about,
and the flag was the one the v1-keystore error used to point people at. stdin
is not an option either, because the passphrase prompt reads from it.

`login` will not replace a keystore it cannot read, `--force` or not: the
replacement is a rename, which needs the directory and not the file, so an
unreadable keystore would otherwise be replaced unseen. `logout` says so when it
finds a keystore it cannot delete. Only a missing file counts as "no keystore";
a file that is there but cannot be looked at is an error, not an absence.

For unattended use, `SQUARE_PRIVATE_KEY` bypasses the keystore. It is announced
on stderr every time, because a key in an environment variable is a key in the
process table.

## Tests

```console
$ npm test                                    # unit, no network
$ LIVE=1 npm test                             # + live reads and a dry run on Arc
$ LIVE=1 SQUARE_PRIVATE_KEY=0x… npm test     # + a real registration (spends gas)
```

The third form is the acceptance test: it drives the built binary to register an
agent on Arc Testnet, then resolves the DID it derived and checks the controller
against the registering address. It needs a funded Arc Testnet address, so it is
skipped unless you supply one.
