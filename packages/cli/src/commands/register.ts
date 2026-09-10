import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from "viem";
import { formatDid } from "@squaresdk/did-resolver";
import { loadCardFromFile, loadCardFromUri, type CardSummary } from "../core/agent-card.js";
import { explorerTxUrl, toViemChain, type Network } from "../core/chains.js";
import { loadConfig, resolveNetwork } from "../core/config.js";
import { SquareError, NetworkError, ValidationError } from "../core/errors.js";
import {
  REGISTER_BARE_ABI,
  REGISTER_WITH_URI_ABI,
  mintedAgentId,
} from "../core/identity-registry.js";
import { log } from "../core/logger.js";
import { c } from "../core/theme.js";
import { keystoreAddress, unlockWallet } from "../core/unlock.js";
import { importPrivateKey, loadKeystore } from "../core/wallet.js";

interface RegisterOpts {
  agentUri?: string;
  cardFile?: string;
  /** commander sets this to false for --no-card-check. */
  cardCheck?: boolean;
  dryRun?: boolean;
  from?: string;
  yes?: boolean;
  json?: boolean;
  chainId?: number;
  rpc?: string;
  registry?: string;
  ipfsGateway?: string;
}

export function registerCommand(): Command {
  return new Command("register")
    .description("Register an agent in the ERC-8004 IdentityRegistry and print its did:aip")
    .option("--agent-uri <uri>", "The agent card URI to record on-chain (https://, ipfs:// or data:)")
    .option("--card-file <path>", "Validate this local file as the card instead of fetching --agent-uri")
    .option("--no-card-check", "Register without reading the card at --agent-uri")
    .option("--dry-run", "Simulate the registration and print the id it would mint")
    .option("--from <address>", "Address to simulate as, with --dry-run (no wallet needed)")
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Machine-readable result")
    .option("--chain-id <n>", "Override the chain id", (v) => Number(v))
    .option("--rpc <url>", "Override the RPC endpoint")
    .option("--registry <address>", "Override the IdentityRegistry address")
    .option("--ipfs-gateway <url>", "Gateway used to read an ipfs:// card")
    .addHelpText(
      "after",
      `
Examples:
  $ square register --agent-uri https://acme.example/agent.json
  $ square register --dry-run --agent-uri ipfs://bafkrei...
  $ square register                      # register with an empty agent URI

The DID is derived from what the chain did, never supplied: the agent id comes
from the ERC-721 Transfer event in the receipt, and the registry and chain id
come from the network the transaction was sent to.

Registering with no --agent-uri is valid ERC-8004 (the no-argument register()).
The agent exists and is owned, and its DID resolves with an empty service list.

With --json, stdout is one JSON record per line: {"status":"sent"} the moment
the transaction is accepted, then {"status":"registered"} (or "reverted") when
the receipt arrives. The last line is the result; the first survives a timeout.
`,
    )
    .action(async (opts: RegisterOpts) => {
      await runRegister(opts);
    });
}

async function runRegister(opts: RegisterOpts): Promise<void> {
  if (opts.cardFile && opts.agentUri === undefined) {
    throw new ValidationError(
      "--card-file validates the card that --agent-uri points at",
      "Pass --agent-uri <uri> as well: the URI is what gets written on-chain.",
    );
  }
  if (opts.cardFile && opts.cardCheck === false) {
    // Silently honouring --no-card-check here would leave the user believing
    // a card was checked that never was.
    throw new ValidationError(
      "--card-file and --no-card-check contradict each other",
      "--card-file validates a card; --no-card-check skips validation. Drop one of them.",
    );
  }

  const config = await loadConfig();
  const network = resolveNetwork(config, {
    chainId: opts.chainId,
    rpc: opts.rpc,
    registry: opts.registry,
  });
  const agentUri = opts.agentUri ?? "";

  // Everything up to the confirmation is a read, and a read needs an address,
  // not a signature. So the passphrase is not asked for yet: the plan is
  // printed and confirmed against the address that will sign, and the key is
  // unlocked only once the user has said yes to what they saw. Resolving the
  // address here, before any network call, also means "you have no wallet" is
  // reported without a round trip.
  let owner: Address;
  if (opts.dryRun) {
    owner = await dryRunAddress(opts.from);
  } else if (opts.from) {
    throw new ValidationError(
      "--from only applies to --dry-run",
      "A real registration is signed by the wallet, so its address is not a choice.",
    );
  } else {
    owner = await signerAddress();
  }

  // Read the card before touching a key. A card that cannot be read is the most
  // common reason to abandon a registration, and it costs nothing to find out.
  let card: CardSummary | null = null;
  if (opts.cardCheck !== false && agentUri) {
    card = opts.cardFile
      ? await loadCardFromFile(opts.cardFile)
      : await loadCardFromUri(agentUri, {
          ipfsGateway: opts.ipfsGateway,
          timeoutMs: config.timeoutMs,
        });
  }

  const publicClient = createPublicClient({ transport: http(network.rpcUrl) }) as PublicClient;
  await assertChainId(publicClient, network);

  await warnIfUnfunded(publicClient, network, owner);

  const simulated = await simulateRegistration(publicClient, network, owner, agentUri);

  printPlan(network, owner, agentUri, card, simulated);

  if (opts.dryRun) {
    log.blank();
    log.success("Dry run — nothing was signed or sent.");
    if (opts.json) {
      log.out(
        JSON.stringify(
          {
            dryRun: true,
            chainId: network.chainId,
            registry: network.identityRegistry,
            owner,
            agentUri,
            predictedAgentId: simulated.toString(),
            predictedDid: formatDid(network.chainId, network.identityRegistry, simulated),
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (!(await confirm(opts, network))) return;

  const wallet = await unlockWallet({ prompt: "Register an agent" });
  if (getAddress(wallet.address) !== owner) {
    // The plan above was simulated and shown for `owner`. A different signer
    // here would register under an address the user never saw.
    throw new SquareError(
      `The unlocked wallet is ${wallet.address}, but the plan was for ${owner}`,
      undefined,
      "The keystore changed while this command was running. Run it again.",
    );
  }

  const walletClient = createWalletClient({
    account: wallet.account,
    chain: toViemChain(network),
    transport: http(network.rpcUrl),
  });

  let hash: `0x${string}`;
  try {
    hash = agentUri
      ? await walletClient.writeContract({
          address: network.identityRegistry,
          abi: REGISTER_WITH_URI_ABI,
          functionName: "register",
          args: [agentUri],
          chain: toViemChain(network),
          account: wallet.account,
        })
      : await walletClient.writeContract({
          address: network.identityRegistry,
          abi: REGISTER_BARE_ABI,
          functionName: "register",
          args: [],
          chain: toViemChain(network),
          account: wallet.account,
        });
  } catch (err) {
    throw new NetworkError(
      `Registration transaction was rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.blank();
  log.step(`Sent ${c.dim(hash)} — waiting for the receipt…`);
  const explorer = explorerTxUrl(network, hash);

  // The hash goes to the machine consumer now, before anything can go wrong
  // with the wait. register() is permissionless and the transaction is out:
  // a timeout below means "no receipt yet", not "no mint", and a --json caller
  // that never saw the hash could not tell those apart, nor resolve the
  // question later.
  const emit = (record: Record<string, unknown>): void => {
    if (opts.json) log.out(JSON.stringify(record));
  };
  emit({
    status: "sent",
    transactionHash: hash,
    chainId: network.chainId,
    registry: network.identityRegistry,
    owner,
    agentUri,
  });

  const timeout = Math.max(config.timeoutMs, 60_000);
  let receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout });
  } catch (err) {
    const timedOut = (err as { name?: string }).name === "WaitForTransactionReceiptTimeoutError";
    throw new NetworkError(
      timedOut
        ? `No receipt for ${hash} after ${Math.round(timeout / 1000)}s`
        : `Could not fetch the receipt for ${hash}: ${err instanceof Error ? err.message : String(err)}`,
      "The transaction may still be mined, and the mint with it. " +
        `${explorer ? `Check ${explorer}` : "Look the hash up on the explorer"}: ` +
        "a Transfer event there is the registration, and its token id is the agent id.",
    );
  }
  if (receipt.status !== "success") {
    emit({ status: "reverted", transactionHash: hash, blockNumber: receipt.blockNumber.toString() });
    throw new NetworkError(
      `Transaction ${hash} reverted`,
      "Nothing was registered. The gas was still spent.",
    );
  }

  const agentId = mintedAgentId({
    logs: receipt.logs,
    registry: network.identityRegistry,
    owner,
  });
  const did = formatDid(network.chainId, network.identityRegistry, agentId);

  if (agentId !== simulated) {
    // Expected, not alarming: register() is permissionless, so another
    // registration can land between the simulation and the mine.
    log.step(
      c.dim(`Minted id ${agentId} (the simulation predicted ${simulated}; another registration landed first).`),
    );
  }

  emit({
    status: "registered",
    did,
    agentId: agentId.toString(),
    chainId: network.chainId,
    registry: network.identityRegistry,
    owner,
    agentUri,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
  });

  log.blank();
  log.success("Agent registered.");
  log.field("did", c.cyan(did));
  log.field("agent id", agentId.toString());
  log.field("owner", owner);
  log.field("tx", hash);
  if (explorer) log.field("explorer", explorer);
  log.blank();
  log.raw(`  Next: ${c.cyan(`square resolve ${did}`)}`);
  log.blank();
}

/**
 * A wrong endpoint would register on a different chain than the DID claims. The
 * resolver makes the same check for the same reason (method spec section 10.4);
 * here it is worse, because a write cannot be retracted.
 */
async function assertChainId(client: PublicClient, network: Network): Promise<void> {
  let actual: number;
  try {
    actual = await client.getChainId();
  } catch (err) {
    throw new NetworkError(
      `Could not reach ${network.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (actual !== network.chainId) {
    throw new NetworkError(
      `${network.rpcUrl} serves chain ${actual}, not ${network.chainId}`,
      "Fix the endpoint before registering; a registration cannot be moved between chains.",
    );
  }
}

/**
 * The address that will sign, without unlocking anything: SQUARE_PRIVATE_KEY,
 * else the keystore on disk. The same precedence as `unlockWallet`, which is
 * what lets the plan be simulated and confirmed before the passphrase is
 * asked for, and what the check after unlocking relies on.
 */
async function signerAddress(): Promise<Address> {
  const fromEnv = process.env.SQUARE_PRIVATE_KEY?.trim();
  if (fromEnv) return importPrivateKey(fromEnv).address;
  return getAddress((await loadKeystore()).address);
}

/**
 * The address a dry run simulates as: --from, else SQUARE_PRIVATE_KEY, else the
 * keystore — none of which requires the passphrase, because a simulation is a read.
 */
async function dryRunAddress(from: string | undefined): Promise<Address> {
  if (from) {
    if (!isAddress(from)) throw new ValidationError(`'${from}' is not a 20-byte address`);
    return getAddress(from);
  }
  const fromEnv = process.env.SQUARE_PRIVATE_KEY?.trim();
  if (fromEnv) return importPrivateKey(fromEnv).address;

  const stored = await keystoreAddress();
  if (!stored) {
    throw new ValidationError(
      "No wallet to simulate as",
      "Pass --from <address>, or run 'square login' first.",
    );
  }
  return getAddress(stored);
}

async function warnIfUnfunded(
  client: PublicClient,
  network: Network,
  address: Address,
): Promise<void> {
  let balance: bigint;
  try {
    balance = await client.getBalance({ address });
  } catch {
    return; // Advisory only; the transaction will report the real problem.
  }
  if (balance === 0n) {
    log.warn(
      `${address} holds no ${network.nativeCurrency.symbol}. ` +
        "Fund it before registering, or the transaction will fail on gas.",
    );
  }
}

/**
 * Simulate first, always.
 *
 * The return value is the id the registry would assign right now, which is what
 * makes --dry-run meaningful and what gives a revert a readable message before
 * a key is used to sign anything.
 */
async function simulateRegistration(
  client: PublicClient,
  network: Network,
  owner: Address,
  agentUri: string,
): Promise<bigint> {
  try {
    if (agentUri) {
      const { result } = await client.simulateContract({
        address: network.identityRegistry,
        abi: REGISTER_WITH_URI_ABI,
        functionName: "register",
        args: [agentUri],
        account: owner,
      });
      return result;
    }
    const { result } = await client.simulateContract({
      address: network.identityRegistry,
      abi: REGISTER_BARE_ABI,
      functionName: "register",
      args: [],
      account: owner,
    });
    return result;
  } catch (err) {
    throw new NetworkError(
      `The registry refused this registration: ${err instanceof Error ? err.message : String(err)}`,
      `Checked against ${network.identityRegistry} on chain ${network.chainId}.`,
    );
  }
}

function printPlan(
  network: Network,
  owner: Address,
  agentUri: string,
  card: CardSummary | null,
  predictedId: bigint,
): void {
  log.blank();
  log.raw(`  ${c.dim("about to register")}`);
  log.field("network", `${network.name} (chain ${network.chainId})`);
  log.field("registry", network.identityRegistry);
  log.field("owner", owner);
  log.field("agent uri", agentUri || c.dim("(empty — valid ERC-8004, no card)"));
  log.field("agent id", `${predictedId} ${c.dim("(assigned by the mint; confirmed from the receipt)")}`);
  log.field(
    "did",
    c.dim(formatDid(network.chainId, network.identityRegistry, predictedId)),
  );

  if (card) {
    log.blank();
    log.raw(`  ${c.dim("agent card")}`);
    log.field("name", card.name ?? c.dim("(none)"));
    if (card.description) log.field("description", truncate(card.description, 60));
    log.field("services", String(card.serviceCount));
    for (const w of card.warnings) log.warn(w);
  }
}

/** True to proceed. Declining is not an error: nothing was sent and nothing failed. */
async function confirm(opts: RegisterOpts, network: Network): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stderr.isTTY) {
    throw new SquareError(
      "Confirmation required",
      undefined,
      "Re-run with --yes from a non-interactive context.",
    );
  }
  log.blank();
  const ok = await p.confirm({
    message: `Sign and submit this registration on ${network.name}?`,
    initialValue: false,
  });
  if (p.isCancel(ok) || ok === false) {
    p.cancel("Cancelled. Nothing was sent.");
    return false;
  }
  return true;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
