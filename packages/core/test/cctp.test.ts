import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, padHex, type Abi, type Address, type Hex, type PublicClient } from "viem";
import {
  bridgeUsdcToArc,
  CCTP_TESTNET_DOMAINS,
  CCTP_V2_TESTNET,
  cctpDomainOf,
  CctpError,
  cctpFees,
  decodeCctpMessage,
  depositForBurn,
  fetchAttestation,
  fromCctpAddress,
  maxFeeFor,
  messageMintsTo,
  messageTransmitterV2Abi,
  reattest,
  receiveMessage,
  toCctpAddress,
  tokenMessengerV2Abi,
  waitForAttestation,
  type SquareWalletClient,
} from "../src/index.js";

/**
 * square#32. The message layout against a real attested transfer from
 * Ethereum Sepolia into Arc (test/fixtures/cctp-sepolia-to-arc.json, with
 * the attestation service's own decoding of it beside the bytes), the
 * attestation service's answers against a fake of it, and the two
 * transactions against a fake chain that records what they send.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "cctp-sepolia-to-arc.json"), "utf8")) as {
  message: Hex;
  attestation: Hex;
  eventNonce: Hex;
  decodedMessage: Record<string, string> & { decodedMessageBody: Record<string, string | null> };
};

const sender = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const arcRecipient = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const txHash = "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8" as const;

describe("a CCTP V2 message decodes as Circle decodes it", () => {
  const decoded = decodeCctpMessage(fixture.message);
  const theirs = fixture.decodedMessage;

  it("the header: domains, nonce, sender, recipient, caller, thresholds", () => {
    expect(decoded.version).toBe(1);
    expect(decoded.sourceDomain).toBe(Number(theirs["sourceDomain"]));
    expect(decoded.destinationDomain).toBe(Number(theirs["destinationDomain"]));
    expect(decoded.destinationDomain).toBe(CCTP_TESTNET_DOMAINS.arcTestnet.domain);
    expect(decoded.nonce).toBe(theirs["nonce"]);
    expect(decoded.nonce).toBe(fixture.eventNonce);
    expect(fromCctpAddress(decoded.sender)).toBe(getAddress(theirs["sender"]!));
    expect(fromCctpAddress(decoded.recipient)).toBe(CCTP_V2_TESTNET.tokenMessenger);
    expect(decoded.destinationCaller).toBe(theirs["destinationCaller"]);
    expect(decoded.minFinalityThreshold).toBe(Number(theirs["minFinalityThreshold"]));
    expect(decoded.finalityThresholdExecuted).toBe(Number(theirs["finalityThresholdExecuted"]));
    expect(decoded.body).toBe(theirs["messageBody"]);
  });

  it("the burn body: token, recipient, amount, sender, fees, expiry, no hook data", () => {
    const body = theirs.decodedMessageBody;
    expect(decoded.burn).not.toBeNull();
    expect(decoded.burn!.version).toBe(1);
    expect(decoded.burn!.burnToken).toBe(getAddress(body["burnToken"]!));
    expect(decoded.burn!.burnToken).toBe(CCTP_TESTNET_DOMAINS.ethereumSepolia.usdc);
    expect(decoded.burn!.mintRecipient).toBe(getAddress(body["mintRecipient"]!));
    expect(decoded.burn!.amount).toBe(BigInt(body["amount"]!));
    expect(decoded.burn!.messageSender).toBe(getAddress(body["messageSender"]!));
    expect(decoded.burn!.maxFee).toBe(BigInt(body["maxFee"]!));
    expect(decoded.burn!.feeExecuted).toBe(BigInt(body["feeExecuted"]!));
    expect(decoded.burn!.expirationBlock).toBe(BigInt(body["expirationBlock"]!));
    expect(decoded.burn!.hookData).toBe("0x");
    expect(messageMintsTo(decoded, decoded.burn!.mintRecipient)).toBe(true);
    expect(messageMintsTo(decoded, sender)).toBe(false);
  });

  it("refuses bytes shorter than a header, and reads a body of another version as no burn", () => {
    expect(() => decodeCctpMessage("0x0001")).toThrow(/at least 148 bytes/);
    const header = fixture.message.slice(0, 2 + 148 * 2) as Hex;
    expect(decodeCctpMessage(header).burn).toBeNull();
  });

  it("addresses pad to 32 bytes and back", () => {
    expect(toCctpAddress(arcRecipient)).toBe(padHex(arcRecipient, { size: 32 }));
    expect(fromCctpAddress(toCctpAddress(arcRecipient))).toBe(arcRecipient);
  });

  it("knows the four testnet domains by chain id, and nothing else", () => {
    expect(cctpDomainOf(11155111).domain).toBe(0);
    expect(cctpDomainOf(84532).domain).toBe(6);
    expect(cctpDomainOf(421614).domain).toBe(3);
    expect(cctpDomainOf(5042002).domain).toBe(26);
    expect(() => cctpDomainOf(1)).toThrow(CctpError);
  });

  it("maxFeeFor rounds up and refuses a fee that is not below the amount", () => {
    expect(maxFeeFor(99n, 1)).toBe(1n);
    expect(maxFeeFor(10_000n, 1)).toBe(1n);
    expect(maxFeeFor(10_001n, 1)).toBe(2n);
    expect(maxFeeFor(5_000_000n, 0)).toBe(0n);
    expect(() => maxFeeFor(2n, 10_000)).toThrow(/not below the amount/);
  });
});

/** Circle's sandbox, as it answered on 2026-09-15, scripted. */
function iris(script: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const path = url.replace("https://iris-api-sandbox.circle.com", "");
    calls.push(path);
    const answers = script[path];
    if (!answers || answers.length === 0) throw new Error(`unscripted ${path}`);
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const notFound = { status: 404, body: { error: "Message not found for provided parameters" } };
const complete = { status: 200, body: { messages: [{ attestation: fixture.attestation, message: fixture.message, eventNonce: fixture.eventNonce, cctpVersion: 2, status: "complete", delayReason: null }] } };
const pending = { status: 200, body: { messages: [{ attestation: "PENDING", message: fixture.message, eventNonce: fixture.eventNonce, cctpVersion: 2, status: "pending_confirmations", delayReason: "insufficient_fee" }] } };

describe("the attestation service", () => {
  it("fees: the two finalities, in basis points", async () => {
    const { fetch, calls } = iris({ "/v2/burn/USDC/fees/0/26": [{ status: 200, body: [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }] }] });
    expect(await cctpFees(0, 26, { fetch })).toEqual([
      { finalityThreshold: 1000, minimumFeeBps: 1 },
      { finalityThreshold: 2000, minimumFeeBps: 0 },
    ]);
    expect(calls).toEqual(["/v2/burn/USDC/fees/0/26"]);
  });

  it("a hash the service has not seen is not-found, a pending one is pending, a complete one carries the message", async () => {
    const path = `/v2/messages/0?transactionHash=${txHash}`;
    const { fetch } = iris({ [path]: [notFound, pending, complete] });
    const options = { fetch, sourceDomain: 0, transactionHash: txHash };
    expect(await fetchAttestation(options)).toMatchObject({ status: "not-found", attestation: null });
    expect(await fetchAttestation(options)).toMatchObject({ status: "pending_confirmations", attestation: null, delayReason: "insufficient_fee" });
    const done = await fetchAttestation(options);
    expect(done.status).toBe("complete");
    expect(done.attestation).toMatchObject({ message: fixture.message, attestation: fixture.attestation, eventNonce: fixture.eventNonce });
    expect(done.attestation!.decoded.burn!.amount).toBe(99n);
  });

  it("waitForAttestation polls through not-found and pending to complete, reporting each", async () => {
    const path = `/v2/messages/0?transactionHash=${txHash}`;
    const { fetch, calls } = iris({ [path]: [notFound, pending, complete] });
    const seen: string[] = [];
    const attestation = await waitForAttestation({ fetch, sourceDomain: 0, transactionHash: txHash, pollIntervalMs: 1, onPending: (status, delay) => seen.push(`${status}${delay ? `:${delay}` : ""}`) });
    expect(attestation.eventNonce).toBe(fixture.eventNonce);
    expect(seen).toEqual(["not-found", "pending_confirmations:insufficient_fee"]);
    expect(calls).toHaveLength(3);
  });

  it("gives up after timeoutMs with the last status, and names the hash to try again with", async () => {
    const path = `/v2/messages/0?transactionHash=${txHash}`;
    const { fetch } = iris({ [path]: [pending] });
    const error = await waitForAttestation({ fetch, sourceDomain: 0, transactionHash: txHash, pollIntervalMs: 5, timeoutMs: 12 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CctpError);
    expect(error).toMatchObject({ code: "attestation-timeout" });
    expect((error as Error).message).toContain("pending_confirmations (insufficient_fee)");
  });

  it("reattest posts the nonce and hands back the service's acknowledgement", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ message: "Re-attestation successfully requested for nonce.", nonce: fixture.eventNonce }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect(await reattest(fixture.eventNonce, { fetch: fetchImpl })).toEqual({ nonce: fixture.eventNonce, message: "Re-attestation successfully requested for nonce." });
    expect(calls).toEqual([{ url: `https://iris-api-sandbox.circle.com/v2/reattest/${fixture.eventNonce}`, method: "POST" }]);
  });

  it("an answer that is not the not-found 404 is an error, not a wait", async () => {
    const path = `/v2/messages/0?transactionHash=${txHash}`;
    const { fetch } = iris({ [path]: [{ status: 500, body: { error: "boom" } }] });
    await expect(fetchAttestation({ fetch, sourceDomain: 0, transactionHash: txHash })).rejects.toMatchObject({ code: "iris", message: "the attestation service answered 500: boom" });
  });
});

interface Call {
  functionName: string;
  args: readonly unknown[];
  address: Address;
  abi: Abi;
}

/** A chain for the two transactions: answers by function, records what is simulated and sent, and serves the receipts given. */
interface FakeLog {
  address: Address;
  topics: readonly (Hex | Hex[] | null)[];
  data: Hex;
}

function chain(options: { chainId?: number; answer: (call: Call) => unknown; logs?: (functionName: string) => FakeLog[] }) {
  const sent: Call[] = [];
  const reads: Call[] = [];
  let lastSent: Call | undefined;
  const publicClient = {
    chain: options.chainId === undefined ? undefined : { id: options.chainId },
    readContract: async (call: Call) => {
      reads.push(call);
      return options.answer(call);
    },
    simulateContract: async (call: Call) => ({ request: call }),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash, blockNumber: 1n, gasUsed: 100_000n, logs: (options.logs?.(lastSent!.functionName) ?? []).map((l, i) => ({ ...l, logIndex: i, blockNumber: 1n, transactionHash: hash, transactionIndex: 0, blockHash: "0x", removed: false })) }),
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: sender },
    chain: options.chainId === undefined ? undefined : { id: options.chainId },
    writeContract: async (call: Call) => {
      sent.push(call);
      lastSent = call;
      return `0x${(sent.length + 100).toString(16).padStart(64, "0")}` as Hex;
    },
  } as unknown as SquareWalletClient;
  return { publicClient, walletClient, sent, reads };
}

const messageSentLog = (message: Hex) => ({
  address: CCTP_V2_TESTNET.messageTransmitter,
  topics: encodeEventTopics({ abi: messageTransmitterV2Abi, eventName: "MessageSent" }),
  data: encodeAbiParameters([{ type: "bytes" }], [message]),
});

describe("depositForBurn", () => {
  const sepolia = CCTP_TESTNET_DOMAINS.ethereumSepolia;
  const feeFetch = iris({ "/v2/burn/USDC/fees/0/26": [{ status: 200, body: [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }] }] }).fetch;

  it("approves when the allowance is short, burns for Arc with the fee the service asks, and hands back the message the transmitter emitted", async () => {
    const c = chain({ chainId: sepolia.chainId, answer: (call) => (call.functionName === "allowance" ? 0n : 0n), logs: (fn) => (fn === "depositForBurn" ? [messageSentLog(fixture.message)] : []) });
    const result = await depositForBurn({ publicClient: c.publicClient, walletClient: c.walletClient, amount: 5_000_000n, recipient: arcRecipient, iris: { fetch: feeFetch } });
    expect(c.sent.map((s) => s.functionName)).toEqual(["approve", "depositForBurn"]);
    expect(c.sent[0]).toMatchObject({ address: sepolia.usdc, args: [CCTP_V2_TESTNET.tokenMessenger, 5_000_000n] });
    expect(c.sent[1]).toMatchObject({
      address: CCTP_V2_TESTNET.tokenMessenger,
      args: [5_000_000n, 26, toCctpAddress(arcRecipient), sepolia.usdc, padHex("0x", { size: 32 }), 500n, 1000],
    });
    expect(result).toMatchObject({ amount: 5_000_000n, maxFee: 500n, minFinalityThreshold: 1000, recipient: arcRecipient, message: fixture.message });
    expect(result.sourceDomain.domain).toBe(0);
    expect(result.decoded.destinationDomain).toBe(26);
  });

  it("sends no approval when the allowance covers the amount, and takes a maxFee and the standard finality when given", async () => {
    const c = chain({ chainId: CCTP_TESTNET_DOMAINS.baseSepolia.chainId, answer: () => 10_000_000n, logs: () => [messageSentLog(fixture.message)] });
    await depositForBurn({ publicClient: c.publicClient, walletClient: c.walletClient, amount: 5_000_000n, finality: "standard", maxFee: 0n });
    expect(c.sent.map((s) => s.functionName)).toEqual(["depositForBurn"]);
    expect(c.sent[0]!.args).toEqual([5_000_000n, 26, toCctpAddress(sender), CCTP_TESTNET_DOMAINS.baseSepolia.usdc, padHex("0x", { size: 32 }), 0n, 2000]);
  });

  it("refuses before sending: an amount the messenger refuses, a fee not below the amount, a chain with no domain, Arc as the source", async () => {
    const c = chain({ chainId: sepolia.chainId, answer: () => 0n });
    await expect(depositForBurn({ publicClient: c.publicClient, walletClient: c.walletClient, amount: 1n, maxFee: 0n })).rejects.toMatchObject({ code: "amount" });
    await expect(depositForBurn({ publicClient: c.publicClient, walletClient: c.walletClient, amount: 100n, maxFee: 100n })).rejects.toMatchObject({ code: "amount" });
    const mainnet = chain({ chainId: 1, answer: () => 0n });
    await expect(depositForBurn({ publicClient: mainnet.publicClient, walletClient: mainnet.walletClient, amount: 100n, maxFee: 0n })).rejects.toMatchObject({ code: "unknown-domain" });
    const arc = chain({ chainId: 5042002, answer: () => 0n });
    await expect(depositForBurn({ publicClient: arc.publicClient, walletClient: arc.walletClient, amount: 100n, maxFee: 0n })).rejects.toMatchObject({ code: "unknown-domain" });
    expect(c.sent).toEqual([]);
  });

  it("is an error when the burn emitted no MessageSent", async () => {
    const c = chain({ chainId: sepolia.chainId, answer: () => 10_000_000n, logs: () => [] });
    await expect(depositForBurn({ publicClient: c.publicClient, walletClient: c.walletClient, amount: 100n, maxFee: 0n })).rejects.toMatchObject({ code: "no-message" });
  });
});

const mintLog = (recipient: Address, amount: bigint, fee: bigint) => ({
  address: CCTP_V2_TESTNET.tokenMessenger,
  topics: encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: "MintAndWithdraw", args: { mintRecipient: recipient, mintToken: CCTP_TESTNET_DOMAINS.arcTestnet.usdc } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, fee]),
});

describe("receiveMessage", () => {
  const minted = decodeCctpMessage(fixture.message).burn!.mintRecipient;

  it("delivers an attested message and reads what was minted", async () => {
    const c = chain({ chainId: 5042002, answer: (call) => (call.functionName === "usedNonces" ? 0n : 0n), logs: () => [mintLog(minted, 98n, 1n)] });
    const result = await receiveMessage({ publicClient: c.publicClient, walletClient: c.walletClient, message: fixture.message, attestation: fixture.attestation });
    expect(c.reads.map((r) => r.functionName)).toEqual(["usedNonces"]);
    expect(c.reads[0]!.args).toEqual([fixture.eventNonce]);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ address: CCTP_V2_TESTNET.messageTransmitter, functionName: "receiveMessage", args: [fixture.message, fixture.attestation] });
    expect(result).toMatchObject({ alreadyReceived: false, nonce: fixture.eventNonce, minted: { recipient: minted, amount: 98n, feeCollected: 1n } });
  });

  it("sends nothing for a nonce the transmitter has already used, and says so", async () => {
    const c = chain({ chainId: 5042002, answer: () => 1n });
    const result = await receiveMessage({ publicClient: c.publicClient, walletClient: c.walletClient, message: fixture.message, attestation: fixture.attestation });
    expect(result).toMatchObject({ hash: null, alreadyReceived: true, minted: null, nonce: fixture.eventNonce });
    expect(c.sent).toEqual([]);
  });
});

describe("bridgeUsdcToArc", () => {
  it("burns, waits, delivers, and reports each step", async () => {
    const source = chain({ chainId: CCTP_TESTNET_DOMAINS.ethereumSepolia.chainId, answer: () => 10_000_000n, logs: () => [messageSentLog(fixture.message)] });
    const minted = decodeCctpMessage(fixture.message).burn!.mintRecipient;
    const arc = chain({ chainId: 5042002, answer: () => 0n, logs: () => [mintLog(minted, 98n, 1n)] });
    const path = `/v2/messages/0?transactionHash=0x${(101).toString(16).padStart(64, "0")}`;
    const { fetch } = iris({ [path]: [notFound, complete] });
    const events: string[] = [];
    const result = await bridgeUsdcToArc({
      publicClient: source.publicClient,
      walletClient: source.walletClient,
      arc: { publicClient: arc.publicClient, walletClient: arc.walletClient },
      amount: 99n,
      maxFee: 1n,
      recipient: minted,
      iris: { fetch },
      attestation: { pollIntervalMs: 1 },
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toEqual(["burned", "attestation-pending", "attested", "received"]);
    expect(result.burn.hash).toBe(`0x${(101).toString(16).padStart(64, "0")}`);
    expect(result.attestation.eventNonce).toBe(fixture.eventNonce);
    expect(result.receive.minted).toEqual({ recipient: minted, amount: 98n, feeCollected: 1n });
    expect(source.sent.map((s) => s.functionName)).toEqual(["depositForBurn"]);
    expect(arc.sent.map((s) => s.functionName)).toEqual(["receiveMessage"]);
  });
});
