import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbiItem, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { anvilAccount } from "./anvil.js";
import { ARC_TESTNET_RPC_URL, CCTP_TESTNET_DOMAINS, CCTP_V2_TESTNET, decodeCctpMessage, depositForBurn, erc20Abi, receiveMessage, tokenMessengerV2Abi, type SquareWalletClient } from "../src/index.js";

/**
 * square#32, the burn against Circle's real TokenMessengerV2 on a fork of
 * Ethereum Sepolia: `anvil --fork-url <sepolia rpc>` at
 * `CCTP_SEPOLIA_FORK_RPC_URL`. The test borrows USDC from whoever the last
 * blocks paid the most (impersonated, funded with fork ether), burns it for
 * an Arc address, and reads the burn and the message the real contracts
 * emitted. Nothing leaves the fork; the attestation and the mint need Circle
 * and Arc, and are the runner's (scripts/bridge.ts). Skipped without the fork,
 * and named on the run as skipped, the way fork.test.ts is.
 */
const forkUrl = process.env["CCTP_SEPOLIA_FORK_RPC_URL"];

const sepoliaFork = defineChain({
  id: 11155111,
  name: "Ethereum Sepolia (fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [forkUrl ?? "http://127.0.0.1:8550"] } },
});

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

describe.skipIf(!forkUrl)("depositForBurn on a fork of Ethereum Sepolia", () => {
  const publicClient = createPublicClient({ chain: sepoliaFork, transport: http(forkUrl) });
  const testClient = createTestClient({ chain: sepoliaFork, mode: "anvil", transport: http(forkUrl) });
  const sepolia = CCTP_TESTNET_DOMAINS.ethereumSepolia;
  const burner = anvilAccount(1);
  const arcRecipient = anvilAccount(2).address;
  const amount = parseUnits("2", 6);

  /** The address the last blocks' largest USDC transfer went to, with at least the amount: someone to borrow from on a fork. */
  async function richHolder(): Promise<Address> {
    const latest = await publicClient.getBlockNumber();
    const logs = await publicClient.getLogs({ address: sepolia.usdc, event: transfer, fromBlock: latest - 400n, toBlock: latest });
    const candidates = [...logs].sort((a, b) => (a.args.value! < b.args.value! ? 1 : -1)).map((log) => log.args.to!);
    for (const candidate of candidates.slice(0, 10)) {
      const balance = await publicClient.readContract({ abi: erc20Abi, address: sepolia.usdc, functionName: "balanceOf", args: [candidate] });
      if (balance >= amount) return candidate;
    }
    throw new Error("no recent USDC recipient on Sepolia holds 2 USDC; widen the window");
  }

  it("burns for Arc through the real TokenMessengerV2, and the message the transmitter emits names Arc, the recipient and the amount", async () => {
    const holder = await richHolder();
    await testClient.impersonateAccount({ address: holder });
    await testClient.setBalance({ address: holder, value: parseUnits("1", 18) });
    await testClient.setBalance({ address: burner.address, value: parseUnits("1", 18) });
    const holderWallet = createWalletClient({ chain: sepoliaFork, transport: http(forkUrl), account: holder });
    const lend = await holderWallet.writeContract({ abi: erc20Abi, address: sepolia.usdc, functionName: "transfer", args: [burner.address, amount] });
    await publicClient.waitForTransactionReceipt({ hash: lend });
    await testClient.stopImpersonatingAccount({ address: holder });
    // Anvil's public account 1 already holds some Sepolia USDC (someone's faucet run); only the delta is asserted.
    expect(await publicClient.readContract({ abi: erc20Abi, address: sepolia.usdc, functionName: "balanceOf", args: [burner.address] })).toBeGreaterThanOrEqual(amount);

    const walletClient = createWalletClient({ chain: sepoliaFork, transport: http(forkUrl), account: burner });
    const before = await publicClient.readContract({ abi: erc20Abi, address: sepolia.usdc, functionName: "balanceOf", args: [burner.address] });
    const result = await depositForBurn({ publicClient, walletClient, amount, recipient: arcRecipient, finality: "fast", maxFee: 1n });
    expect(result.receipt.status).toBe("success");
    // The burn took the whole amount off the source balance; the fee is the attester's, on Arc.
    expect(await publicClient.readContract({ abi: erc20Abi, address: sepolia.usdc, functionName: "balanceOf", args: [burner.address] })).toBe(before - amount);

    const burned = parseEventLogs({ abi: tokenMessengerV2Abi, logs: result.receipt.logs, eventName: "DepositForBurn" });
    expect(burned).toHaveLength(1);
    expect(burned[0]!.address.toLowerCase()).toBe(CCTP_V2_TESTNET.tokenMessenger.toLowerCase());
    expect(burned[0]!.args).toMatchObject({ burnToken: sepolia.usdc, amount, depositor: burner.address, destinationDomain: 26, maxFee: 1n, minFinalityThreshold: 1000 });

    const decoded = decodeCctpMessage(result.message);
    expect(decoded).toMatchObject({ version: 1, sourceDomain: 0, destinationDomain: 26, minFinalityThreshold: 1000, finalityThresholdExecuted: 0 });
    expect(decoded.nonce).toBe(`0x${"0".repeat(64)}`); // the attestation service assigns it
    expect(decoded.burn).toMatchObject({ burnToken: sepolia.usdc, mintRecipient: arcRecipient, amount, messageSender: burner.address, maxFee: 1n, feeExecuted: 0n, hookData: "0x" });
    expect(result.decoded).toEqual(decoded);
  }, 120_000);

  it("reads a message Arc has already minted as received, and sends nothing for it", async () => {
    // The fixture's transfer was minted on Arc on 2026-09-15 (its destinationMintTxHash); the transmitter's usedNonces says so, and the read is all this needs.
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(readFileSync(join(here, "fixtures", "cctp-sepolia-to-arc.json"), "utf8")) as { message: Hex; attestation: Hex; eventNonce: Hex };
    const arc = createPublicClient({ transport: http(ARC_TESTNET_RPC_URL) });
    const sent: unknown[] = [];
    const walletClient = { account: { address: anvilAccount(2).address }, writeContract: async (request: unknown) => (sent.push(request), "0x") } as unknown as SquareWalletClient;
    const result = await receiveMessage({ publicClient: arc, walletClient, message: fixture.message, attestation: fixture.attestation });
    expect(result).toMatchObject({ alreadyReceived: true, hash: null, minted: null, nonce: fixture.eventNonce });
    expect(sent).toEqual([]);
  }, 60_000);
});
