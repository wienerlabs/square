import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, hashTypedData, http, keccak256, stringToHex, type Address } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { screeningRegistryAbi } from "@squaresdk/core";
import { SCREENING_DOMAIN_NAME, SCREENING_DOMAIN_VERSION, SCREENING_TYPES, TRM_SOURCE_ID, signScreening, submitScreenings, type Screening } from "../src/index.js";

const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));

async function anvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return ((await response.json()) as { result?: string }).result === "0x7a69";
  } catch {
    return false;
  }
}

const reachable = await anvilReachable();

// The registry is the contract in contracts/src, deployed from its forge
// artifact; the screener's signatures are checked by it, not by a copy of it.
describe.skipIf(!reachable)("ScreeningRegistry accepts what the screener signs", () => {
  // anvil's published development mnemonic; its keys guard nothing.
  const owner = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 });
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: owner });
  const screener = privateKeyToAccount(generatePrivateKey());
  let registry: Address;

  beforeAll(async () => {
    const artifact = JSON.parse(readFileSync(join(here, "..", "..", "..", "contracts", "out", "ScreeningRegistry.sol", "ScreeningRegistry.json"), "utf8"));
    const deployed = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address, 3600n] });
    registry = (await publicClient.waitForTransactionReceipt({ hash: deployed })).contractAddress as Address;
    const registered = await wallet.writeContract({ address: registry, abi: screeningRegistryAbi, functionName: "setScreener", args: [screener.address, true] });
    await publicClient.waitForTransactionReceipt({ hash: registered });
  });

  async function screeningOf(sanctioned: boolean): Promise<Screening> {
    const subject = privateKeyToAccount(generatePrivateKey()).address;
    const body = JSON.stringify([{ address: subject, isSanctioned: sanctioned }]);
    return {
      subject,
      sanctioned,
      screenedAt: (await publicClient.getBlock()).timestamp,
      source: stringToHex(TRM_SOURCE_ID, { size: 32 }),
      evidence: keccak256(stringToHex(body)),
    };
  }

  it("computes the same digest as the contract", async () => {
    const screening = await screeningOf(false);
    const onChain = await publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "digestOf", args: [screening] });
    const offChain = hashTypedData({
      domain: { name: SCREENING_DOMAIN_NAME, version: SCREENING_DOMAIN_VERSION, chainId: foundry.id, verifyingContract: registry },
      types: SCREENING_TYPES,
      primaryType: "Screening",
      message: screening,
    });
    expect(onChain).toBe(offChain);
  });

  it("records what it signs: a clean subject is cleared, a sanctioned one is not", async () => {
    const domain = { chainId: foundry.id, registry };
    const clean = await screeningOf(false);
    const sanctioned = await screeningOf(true);
    const signed = [
      { screening: clean, signature: await signScreening(screener, domain, clean) },
      { screening: sanctioned, signature: await signScreening(screener, domain, sanctioned) },
    ];
    await submitScreenings(wallet, publicClient, registry, signed);
    const cleared = (subject: Address) => publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "isCleared", args: [subject] });
    expect(await cleared(clean.subject)).toBe(true);
    expect(await cleared(sanctioned.subject)).toBe(false);
  });

  it("records nothing a key it does not recognise signed", async () => {
    const impostor = privateKeyToAccount(generatePrivateKey());
    const screening = await screeningOf(false);
    const signature = await signScreening(impostor, { chainId: foundry.id, registry }, screening);
    await expect(submitScreenings(wallet, publicClient, registry, [{ screening, signature }])).rejects.toThrow(/NotAScreener/);
  });
});
