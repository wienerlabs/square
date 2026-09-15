import {
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  padHex,
  parseEventLogs,
  size,
  sliceHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { erc20Abi } from "../abi/index.js";
import type { SquareWalletClient } from "../client.js";
import { ARC_TESTNET_CHAIN_ID, deploymentFor } from "../deployments.js";
import { messageTransmitterV2Abi, tokenMessengerV2Abi } from "./abi.js";

/**
 * USDC into Arc from another chain, over Circle's CCTP V2 (square#32).
 *
 * The transfer is a burn on the source chain, an attestation from Circle's
 * service, and a mint on Arc, in that order and by three different hands:
 * the source wallet burns (`depositForBurn`), Circle signs
 * (`waitForAttestation`), and whoever holds the attestation mints on Arc
 * (`receiveMessage`), after which the USDC is the recipient's Arc balance
 * and funds a job the way any other USDC does. `bridgeUsdcToArc` runs the
 * three in a row; each is also callable on its own, which is what recovery
 * is: a burn whose attestation was never fetched is fetched by its hash, an
 * attestation that was never delivered is delivered, and one that someone
 * else delivered is read as such from the transmitter's `usedNonces`.
 *
 * Every constant here was read back from the chains and from Circle's
 * service on 2026-09-15, not copied from a page: Arc Testnet's transmitter
 * answers `localDomain() == 26`, its minter maps the three source USDCs to
 * `0x3600…`, and the three source messengers know domain 26.
 */

/** The shared CCTP V2 contract addresses on the EVM testnets, Arc Testnet included. */
export const CCTP_V2_TESTNET = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinter: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
} as const satisfies Record<string, Address>;

/** Circle's attestation service for the testnets. Mainnet is `https://iris-api.circle.com`. */
export const IRIS_SANDBOX_URL = "https://iris-api-sandbox.circle.com";

/** `minFinalityThreshold`: 1000 is a Fast Transfer, attested at soft finality for a fee; 2000 a Standard Transfer, attested at hard finality. */
export const CCTP_FINALITY = { fast: 1000, standard: 2000 } as const;
export type CctpFinality = keyof typeof CCTP_FINALITY;

export interface CctpDomain {
  /** Circle's domain id, what the message header carries. */
  domain: number;
  chainId: number;
  name: string;
  /** The USDC the domain's TokenMessenger burns or mints. */
  usdc: Address;
}

/** The domains a testnet transfer into Arc can start from, and Arc itself (its chain id and USDC from `deployments.ts`, the one place they are declared). */
export const CCTP_TESTNET_DOMAINS = {
  arcTestnet: { domain: 26, chainId: ARC_TESTNET_CHAIN_ID, name: "Arc Testnet", usdc: deploymentFor(ARC_TESTNET_CHAIN_ID).usdc },
  ethereumSepolia: { domain: 0, chainId: 11155111, name: "Ethereum Sepolia", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  baseSepolia: { domain: 6, chainId: 84532, name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  arbitrumSepolia: { domain: 3, chainId: 421614, name: "Arbitrum Sepolia", usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
} as const satisfies Record<string, CctpDomain>;

export class CctpError extends Error {
  constructor(
    message: string,
    readonly code: "unknown-domain" | "no-message" | "iris" | "attestation-timeout" | "already-received" | "amount",
  ) {
    super(message);
    this.name = "CctpError";
  }
}

/** The domain a chain id belongs to, among the testnets above. */
export function cctpDomainOf(chainId: number): CctpDomain {
  const found = Object.values(CCTP_TESTNET_DOMAINS).find((d) => d.chainId === chainId);
  if (!found) throw new CctpError(`chain ${chainId} is not a CCTP testnet domain this package knows`, "unknown-domain");
  return found;
}

/** An EVM address as the 32 bytes CCTP carries it in: left-padded. */
export function toCctpAddress(address: Address): Hex {
  return padHex(address, { size: 32 });
}

/** The address in a 32-byte CCTP field, checksummed. */
export function fromCctpAddress(field: Hex): Address {
  return getAddress(sliceHex(field, 12, 32));
}

/** A CCTP V2 message, as `MessageV2.sol` lays it out. */
export interface CctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** Zero in the `MessageSent` event; assigned by the attestation service, and what `usedNonces` is keyed by. */
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: Hex;
  /** The body as `BurnMessageV2.sol` lays it out, when it is one (version 1). */
  burn: CctpBurnBody | null;
}

export interface CctpBurnBody {
  version: number;
  burnToken: Address;
  mintRecipient: Address;
  amount: bigint;
  messageSender: Address;
  maxFee: bigint;
  /** Zero in the event; what the attester charged, once attested. */
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
}

const HEADER_LENGTH = 148;
const BURN_BODY_LENGTH = 228;

/** Decode a V2 message (the `MessageSent` payload, or what the attestation service returns). */
export function decodeCctpMessage(message: Hex): CctpMessage {
  if (size(message) < HEADER_LENGTH) throw new CctpError(`a CCTP V2 message is at least ${HEADER_LENGTH} bytes; this one is ${size(message)}`, "no-message");
  const uint32At = (offset: number) => hexToNumber(sliceHex(message, offset, offset + 4));
  const bytes32At = (offset: number) => sliceHex(message, offset, offset + 32);
  const body: Hex = size(message) > HEADER_LENGTH ? sliceHex(message, HEADER_LENGTH) : "0x";
  return {
    version: uint32At(0),
    sourceDomain: uint32At(4),
    destinationDomain: uint32At(8),
    nonce: bytes32At(12),
    sender: bytes32At(44),
    recipient: bytes32At(76),
    destinationCaller: bytes32At(108),
    minFinalityThreshold: uint32At(140),
    finalityThresholdExecuted: uint32At(144),
    body,
    burn: decodeBurnBody(body),
  };
}

function decodeBurnBody(body: Hex): CctpBurnBody | null {
  if (size(body) < BURN_BODY_LENGTH) return null;
  const version = hexToNumber(sliceHex(body, 0, 4));
  if (version !== 1) return null;
  const at = (offset: number) => sliceHex(body, offset, offset + 32);
  return {
    version,
    burnToken: fromCctpAddress(at(4)),
    mintRecipient: fromCctpAddress(at(36)),
    amount: hexToBigInt(at(68)),
    messageSender: fromCctpAddress(at(100)),
    maxFee: hexToBigInt(at(132)),
    feeExecuted: hexToBigInt(at(164)),
    expirationBlock: hexToBigInt(at(196)),
    hookData: size(body) > BURN_BODY_LENGTH ? sliceHex(body, BURN_BODY_LENGTH) : "0x",
  };
}

export interface IrisOptions {
  /** The attestation service's origin; the sandbox by default, which serves every testnet. */
  url?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export interface CctpFee {
  finalityThreshold: number;
  /** In basis points of the amount. */
  minimumFeeBps: number;
}

/** What Circle charges between two domains, per finality: `GET /v2/burn/USDC/fees/{source}/{destination}`. */
export async function cctpFees(sourceDomain: number, destinationDomain: number, options: IrisOptions = {}): Promise<CctpFee[]> {
  const body = await irisGet(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`, options);
  if (!Array.isArray(body)) throw new CctpError("the fee endpoint answered without a list", "iris");
  return body.map((entry) => {
    const { finalityThreshold, minimumFee } = entry as { finalityThreshold?: unknown; minimumFee?: unknown };
    if (typeof finalityThreshold !== "number" || typeof minimumFee !== "number") throw new CctpError("the fee endpoint answered without finalityThreshold and minimumFee", "iris");
    return { finalityThreshold, minimumFeeBps: minimumFee };
  });
}

/** The `maxFee` for an amount at a fee in basis points, rounded up, as the contract requires it below the amount. */
export function maxFeeFor(amount: bigint, minimumFeeBps: number): bigint {
  const fee = (amount * BigInt(minimumFeeBps) + 9_999n) / 10_000n;
  if (fee >= amount) throw new CctpError(`a fee of ${minimumFeeBps} bps on ${amount} is ${fee}, not below the amount; send more`, "amount");
  return fee;
}

async function irisGet(path: string, options: IrisOptions, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const base = (options.url ?? IRIS_SANDBOX_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, { method, headers: { accept: "application/json" } });
  } catch (error) {
    throw new CctpError(`the attestation service at ${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`, "iris");
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CctpError(`the attestation service answered ${response.status} with a body that is not JSON`, "iris");
  }
  if (!response.ok) {
    const error = (body as { error?: unknown }).error;
    // A hash the service has not seen yet answers 404 with this text; it is "not yet", not "never".
    if (response.status === 404 && typeof error === "string" && /not found/i.test(error)) return null;
    throw new CctpError(`the attestation service answered ${response.status}: ${typeof error === "string" ? error : text.slice(0, 200)}`, "iris");
  }
  return body;
}

export interface Attestation {
  message: Hex;
  attestation: Hex;
  eventNonce: Hex;
  decoded: CctpMessage;
}

export interface WaitForAttestationOptions extends IrisOptions {
  sourceDomain: number;
  transactionHash: Hex;
  /** How often the service is asked. Default 5 s. */
  pollIntervalMs?: number | undefined;
  /** How long to wait in all. A fast transfer attests in seconds, a standard one at the source chain's finality, ~15 minutes on Ethereum. Default 30 minutes. */
  timeoutMs?: number | undefined;
  onPending?: ((status: string, delayReason: string | null) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Circle's attestation of the burn in `transactionHash`, once its status is
 * `complete`: `GET /v2/messages/{sourceDomain}?transactionHash=…`, polled.
 * The message returned is the one to deliver on Arc, with the nonce and the
 * fee the attester filled in; the event's copy has neither.
 */
export async function waitForAttestation(options: WaitForAttestationOptions): Promise<Attestation> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const found = await fetchAttestation(options);
    if (found.attestation !== null) return found.attestation;
    options.onPending?.(found.status, found.delayReason);
    if (Date.now() + pollIntervalMs > deadline) {
      throw new CctpError(`no attestation for ${options.transactionHash} within ${options.timeoutMs ?? 30 * 60_000} ms; last status ${found.status}${found.delayReason ? ` (${found.delayReason})` : ""}. Fetch it later with the same hash.`, "attestation-timeout");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}

/** One look at the service, without waiting: the attestation when `complete`, the status otherwise. */
export async function fetchAttestation(
  options: IrisOptions & { sourceDomain: number; transactionHash: Hex },
): Promise<{ status: "complete"; attestation: Attestation; delayReason: null } | { status: string; attestation: null; delayReason: string | null }> {
  const body = await irisGet(`/v2/messages/${options.sourceDomain}?transactionHash=${options.transactionHash}`, options);
  if (body === null) return { status: "not-found", attestation: null, delayReason: null };
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return { status: "not-found", attestation: null, delayReason: null };
  const [first] = messages as { status?: unknown; message?: unknown; attestation?: unknown; eventNonce?: unknown; delayReason?: unknown }[];
  const status = typeof first!.status === "string" ? first!.status : "unknown";
  const delayReason = typeof first!.delayReason === "string" ? first!.delayReason : null;
  if (status !== "complete") return { status, attestation: null, delayReason };
  const { message, attestation, eventNonce } = first!;
  if (typeof message !== "string" || typeof attestation !== "string" || !message.startsWith("0x") || !attestation.startsWith("0x")) {
    throw new CctpError("the attestation service says complete but carries no message and attestation", "iris");
  }
  const decoded = decodeCctpMessage(message as Hex);
  return {
    status: "complete",
    attestation: { message: message as Hex, attestation: attestation as Hex, eventNonce: typeof eventNonce === "string" ? (eventNonce as Hex) : decoded.nonce, decoded },
    delayReason: null,
  };
}

/**
 * Ask Circle to sign a message again. The attester writes an expiration
 * block a day ahead into the message before signing, and Arc's transmitter
 * respects it; a burn whose attestation lapsed unminted is not lost as long
 * as the burn is on the source chain: `POST /v2/reattest/{nonce}`, then
 * `waitForAttestation` with the burn's hash again, then `receiveMessage`
 * before the new block passes.
 */
export async function reattest(nonce: Hex, options: IrisOptions = {}): Promise<{ nonce: Hex; message: string }> {
  const body = await irisGet(`/v2/reattest/${nonce}`, options, "POST");
  const answer = (body ?? {}) as { nonce?: unknown; message?: unknown };
  return { nonce: typeof answer.nonce === "string" ? (answer.nonce as Hex) : nonce, message: typeof answer.message === "string" ? answer.message : "" };
}

export interface DepositForBurnOptions {
  /** The source chain: the clients' chain id names the domain, or `domain` does. */
  publicClient: PublicClient;
  walletClient: SquareWalletClient;
  domain?: CctpDomain | undefined;
  /** Units of USDC (6 decimals). */
  amount: bigint;
  /** Who is minted to on Arc. Default: the source wallet's own address. */
  recipient?: Address | undefined;
  destination?: CctpDomain | undefined;
  finality?: CctpFinality | undefined;
  /** The most the attester may take, in USDC units; `maxFeeFor` from `cctpFees`. Default: what the service asks for the finality. */
  maxFee?: bigint | undefined;
  /** Who may deliver the message on Arc. Default: anyone. */
  destinationCaller?: Address | undefined;
  tokenMessenger?: Address | undefined;
  iris?: IrisOptions | undefined;
}

export interface DepositForBurnResult {
  hash: Hex;
  receipt: TransactionReceipt;
  sourceDomain: CctpDomain;
  destinationDomain: CctpDomain;
  amount: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  recipient: Address;
  /** The message the transmitter emitted, nonce and fee still empty; the attested copy is what Arc takes. */
  message: Hex;
  decoded: CctpMessage;
}

/**
 * Burn USDC on the source chain for Arc: an allowance to the TokenMessenger
 * when short, then `depositForBurn`. Nothing is sent when the amount cannot
 * carry the fee.
 */
export async function depositForBurn(options: DepositForBurnOptions): Promise<DepositForBurnResult> {
  const chainId = options.walletClient.chain?.id ?? options.publicClient.chain?.id;
  const source = options.domain ?? (chainId === undefined ? undefined : cctpDomainOf(chainId));
  if (source === undefined) throw new CctpError("pass a domain when the clients carry no chain", "unknown-domain");
  const destination = options.destination ?? CCTP_TESTNET_DOMAINS.arcTestnet;
  if (destination.domain === source.domain) throw new CctpError(`${source.name} is the destination too`, "unknown-domain");
  const finality = options.finality ?? "fast";
  const minFinalityThreshold = CCTP_FINALITY[finality];
  if (options.amount <= 1n) throw new CctpError("the TokenMessenger refuses an amount of 1 unit or less", "amount");
  let maxFee = options.maxFee;
  if (maxFee === undefined) {
    const fees = await cctpFees(source.domain, destination.domain, options.iris ?? {});
    const fee = fees.find((f) => f.finalityThreshold === minFinalityThreshold) ?? fees.find((f) => f.finalityThreshold >= minFinalityThreshold);
    if (!fee) throw new CctpError(`the attestation service names no fee for finality ${minFinalityThreshold} from ${source.name} to ${destination.name}`, "iris");
    maxFee = maxFeeFor(options.amount, fee.minimumFeeBps);
  } else if (maxFee >= options.amount) {
    throw new CctpError(`maxFee ${maxFee} is not below the amount ${options.amount}`, "amount");
  }
  const account = options.walletClient.account;
  const recipient = options.recipient ?? account.address;
  const tokenMessenger = options.tokenMessenger ?? CCTP_V2_TESTNET.tokenMessenger;
  const { publicClient, walletClient } = options;

  const allowance = await publicClient.readContract({ abi: erc20Abi, address: source.usdc, functionName: "allowance", args: [account.address, tokenMessenger] });
  if (allowance < options.amount) {
    const { request } = await publicClient.simulateContract({ abi: erc20Abi, address: source.usdc, functionName: "approve", args: [tokenMessenger, options.amount], account });
    const approval = await walletClient.writeContract(request);
    const approved = await publicClient.waitForTransactionReceipt({ hash: approval });
    if (approved.status !== "success") throw new CctpError(`the USDC approval ${approval} reverted`, "amount");
  }
  const { request } = await publicClient.simulateContract({
    abi: tokenMessengerV2Abi,
    address: tokenMessenger,
    functionName: "depositForBurn",
    args: [options.amount, destination.domain, toCctpAddress(recipient), source.usdc, options.destinationCaller ? toCctpAddress(options.destinationCaller) : padHex("0x", { size: 32 }), maxFee, minFinalityThreshold],
    account,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new CctpError(`depositForBurn ${hash} reverted`, "amount");
  const sent = parseEventLogs({ abi: messageTransmitterV2Abi, logs: receipt.logs, eventName: "MessageSent" });
  if (sent.length === 0) throw new CctpError(`${hash} emitted no MessageSent`, "no-message");
  const message = sent[0]!.args.message;
  return { hash, receipt, sourceDomain: source, destinationDomain: destination, amount: options.amount, maxFee, minFinalityThreshold, recipient, message, decoded: decodeCctpMessage(message) };
}

export interface ReceiveMessageOptions {
  /** Arc: the chain the message is for. */
  publicClient: PublicClient;
  walletClient: SquareWalletClient;
  message: Hex;
  attestation: Hex;
  messageTransmitter?: Address | undefined;
  tokenMessenger?: Address | undefined;
}

export interface ReceiveMessageResult {
  /** Null when the nonce was already used: someone delivered it first, and the mint is theirs to have made. */
  hash: Hex | null;
  receipt: TransactionReceipt | null;
  nonce: Hex;
  alreadyReceived: boolean;
  /** What the TokenMessenger minted, from `MintAndWithdraw`; null when this call did not mint. */
  minted: { recipient: Address; amount: bigint; feeCollected: bigint } | null;
}

/**
 * Deliver an attested message on Arc: `MessageTransmitterV2.receiveMessage`,
 * which has the TokenMinter mint the USDC to the recipient. A nonce the
 * transmitter has already used is reported, not sent again.
 */
export async function receiveMessage(options: ReceiveMessageOptions): Promise<ReceiveMessageResult> {
  const transmitter = options.messageTransmitter ?? CCTP_V2_TESTNET.messageTransmitter;
  const tokenMessenger = options.tokenMessenger ?? CCTP_V2_TESTNET.tokenMessenger;
  const decoded = decodeCctpMessage(options.message);
  const used = await options.publicClient.readContract({ abi: messageTransmitterV2Abi, address: transmitter, functionName: "usedNonces", args: [decoded.nonce] });
  if (used !== 0n) return { hash: null, receipt: null, nonce: decoded.nonce, alreadyReceived: true, minted: null };
  const { request } = await options.publicClient.simulateContract({
    abi: messageTransmitterV2Abi,
    address: transmitter,
    functionName: "receiveMessage",
    args: [options.message, options.attestation],
    account: options.walletClient.account,
  });
  const hash = await options.walletClient.writeContract(request);
  const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new CctpError(`receiveMessage ${hash} reverted`, "no-message");
  const minted = parseEventLogs({ abi: tokenMessengerV2Abi, logs: receipt.logs, eventName: "MintAndWithdraw" }).find((log) => isAddressEqual(log.address, tokenMessenger));
  return {
    hash,
    receipt,
    nonce: decoded.nonce,
    alreadyReceived: false,
    minted: minted ? { recipient: minted.args.mintRecipient, amount: minted.args.amount, feeCollected: minted.args.feeCollected } : null,
  };
}

export type BridgeEvent =
  | { type: "burned"; hash: Hex; amount: bigint; maxFee: bigint; sourceDomain: CctpDomain }
  | { type: "attestation-pending"; status: string; delayReason: string | null }
  | { type: "attested"; nonce: Hex; feeExecuted: bigint | null }
  | { type: "received"; hash: Hex | null; alreadyReceived: boolean; minted: ReceiveMessageResult["minted"] };

export interface BridgeUsdcToArcOptions extends Omit<DepositForBurnOptions, "destination"> {
  arc: { publicClient: PublicClient; walletClient: SquareWalletClient };
  attestation?: Pick<WaitForAttestationOptions, "pollIntervalMs" | "timeoutMs" | "signal"> | undefined;
  onEvent?: ((event: BridgeEvent) => void) | undefined;
}

export interface BridgeUsdcToArcResult {
  burn: DepositForBurnResult;
  attestation: Attestation;
  receive: ReceiveMessageResult;
}

/** The three steps in a row; the events say where it stands, and each step's own call is the recovery when it stops. */
export async function bridgeUsdcToArc(options: BridgeUsdcToArcOptions): Promise<BridgeUsdcToArcResult> {
  const { arc, attestation: waiting, onEvent, ...burnOptions } = options;
  const burn = await depositForBurn({ ...burnOptions, destination: CCTP_TESTNET_DOMAINS.arcTestnet });
  onEvent?.({ type: "burned", hash: burn.hash, amount: burn.amount, maxFee: burn.maxFee, sourceDomain: burn.sourceDomain });
  const attestation = await waitForAttestation({
    ...(options.iris ?? {}),
    ...(waiting ?? {}),
    sourceDomain: burn.sourceDomain.domain,
    transactionHash: burn.hash,
    onPending: (status, delayReason) => onEvent?.({ type: "attestation-pending", status, delayReason }),
  });
  onEvent?.({ type: "attested", nonce: attestation.eventNonce, feeExecuted: attestation.decoded.burn?.feeExecuted ?? null });
  const receive = await receiveMessage({ publicClient: arc.publicClient, walletClient: arc.walletClient, message: attestation.message, attestation: attestation.attestation });
  onEvent?.({ type: "received", hash: receive.hash, alreadyReceived: receive.alreadyReceived, minted: receive.minted });
  return { burn, attestation, receive };
}

/** Whether a message is for Arc and pays the address given, before anything is sent for it. */
export function messageMintsTo(decoded: CctpMessage, recipient: Address): boolean {
  return decoded.destinationDomain === CCTP_TESTNET_DOMAINS.arcTestnet.domain && decoded.burn !== null && isAddressEqual(decoded.burn.mintRecipient, recipient) && !isAddressEqual(decoded.burn.mintRecipient, zeroAddress);
}
