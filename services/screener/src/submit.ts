import { screeningRegistryAbi } from "@squaresdk/core";
import { getAddress, isAddressEqual, parseEventLogs, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import type { SignedScreening } from "./screen.js";

export interface Submission {
  transactionHash: Hex;
  /** The subjects this transaction recorded, read from its `Screened` events. */
  recorded: ReadonlySet<Address>;
}

/**
 * Record signed screenings in the registry. The registry trusts the signatures,
 * not this sender, so anyone holding them could submit them; the screener does
 * so itself so that a screening it answered is on chain before the caller acts
 * on it.
 *
 * A screening that is not valid refuses the batch. A subject whose held record
 * is already as recent, an address screened twice in one second of chain time,
 * is skipped by the registry and the rest are recorded; `recorded` says which.
 */
export async function submitScreenings(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  registry: Address,
  signed: readonly SignedScreening[],
): Promise<Submission> {
  const hash = await walletClient.writeContract({
    address: registry,
    abi: screeningRegistryAbi,
    functionName: "submitMany",
    args: [signed.map((s) => s.screening), signed.map((s) => s.signature)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`submitMany reverted in ${hash}`);
  const screened = parseEventLogs({ abi: screeningRegistryAbi, logs: receipt.logs, eventName: "Screened" });
  const recorded = new Set(screened.filter((log) => isAddressEqual(log.address, registry)).map((log) => getAddress(log.args.subject)));
  return { transactionHash: hash, recorded };
}
