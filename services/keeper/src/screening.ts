import { claimMarketAbi, screeningRegistryAbi, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { zeroAddress, type Address, type PublicClient } from "viem";

export type PayeeScreeningState = "no-screening" | "cleared" | "sanctioned" | "unscreened";

export interface PayeeScreening {
  /**
   * Finalize now. True when the job's hook screens nobody, when the payee is
   * cleared, and when a fresh screening says the payee is designated: then the
   * refusal is the outcome the screening exists to produce, and holding the job
   * would only delay the client's refund.
   */
  proceed: boolean;
  state: PayeeScreeningState;
  payee?: Address;
}

export interface PayeeScreeningOptions {
  client: Pick<SquareClient, "getJobRecord">;
  publicClient: Pick<PublicClient, "readContract" | "getBlock">;
  screenerUrl: string;
  timeoutMs?: number;
}

/**
 * square#35, decision §4: before a release, ask the screener for a fresh
 * screening of the payee, then let the registry decide.
 *
 * The screener's answer is not trusted here, only what reached the chain. An
 * unreachable screener leaves whatever record the registry already holds, which
 * still clears the payee if it is younger than `maxAge`. What the keeper will not
 * do is finalize a payee nobody has freshly screened: the hook would refuse the
 * release and the provider would lose a payment to an outage. It holds the job
 * instead, and the next tick asks again.
 */
export function payeeScreening(options: PayeeScreeningOptions): (jobId: bigint) => Promise<PayeeScreening> {
  const { publicClient } = options;
  return async (jobId) => {
    const { hook } = await options.client.getJobRecord(jobId);
    if (hook === zeroAddress) return { proceed: true, state: "no-screening" };
    let registry: Address;
    try {
      registry = await publicClient.readContract({ address: hook, abi: squareHookAbi, functionName: "screening" });
    } catch {
      // A whitelisted hook that is not a SquareHook has no screening to ask about.
      return { proceed: true, state: "no-screening" };
    }
    if (registry === zeroAddress) return { proceed: true, state: "no-screening" };

    const market = await publicClient.readContract({ address: hook, abi: squareHookAbi, functionName: "claimMarket" });
    const payee = await publicClient.readContract({ address: market, abi: claimMarketAbi, functionName: "payeeOf", args: [jobId] });
    try {
      await fetch(`${options.screenerUrl}/screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: [payee] }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      // Nothing to do: the registry below is what decides.
    }

    const cleared = await publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "isCleared", args: [payee] });
    if (cleared) return { proceed: true, state: "cleared", payee };
    const [record, maxAge, latest] = await Promise.all([
      publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "screeningOf", args: [payee] }),
      publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "maxAge" }),
      publicClient.getBlock(),
    ]);
    const signerStillRegistered =
      record.screenedAt !== 0n &&
      (await publicClient.readContract({ address: registry, abi: screeningRegistryAbi, functionName: "isScreener", args: [record.screener] }));
    const fresh = record.screenedAt !== 0n && latest.timestamp - record.screenedAt <= maxAge;
    if (record.sanctioned && fresh && signerStillRegistered) return { proceed: true, state: "sanctioned", payee };
    return { proceed: false, state: "unscreened", payee };
  };
}
