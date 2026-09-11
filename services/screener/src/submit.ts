import { screeningRegistryAbi } from "@squaresdk/core";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import type { SignedScreening } from "./screen.js";

/**
 * Record signed screenings in the registry, all or nothing. The registry trusts
 * the signatures, not this sender, so anyone holding them could submit them; the
 * screener does so itself so that a screening it answered is on chain before the
 * caller acts on it.
 */
export async function submitScreenings(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  registry: Address,
  signed: readonly SignedScreening[],
): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: registry,
    abi: screeningRegistryAbi,
    functionName: "submitMany",
    args: [signed.map((s) => s.screening), signed.map((s) => s.signature)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`submitMany reverted in ${hash}`);
  return hash;
}
