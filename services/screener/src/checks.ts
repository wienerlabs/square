import { screeningRegistryAbi } from "@squaresdk/core";
import type { CheckResult, HealthCheck } from "@squaresdk/observability";
import type { Address, PublicClient } from "viem";

export const DEFAULT_MIN_SUBMITS_FUNDED = 3;

export interface ScreenerChecksOptions {
  publicClient: Pick<PublicClient, "getChainId" | "getBalance" | "getGasPrice" | "readContract">;
  chainId: number;
  account: Address;
  registry: Address;
  submitGas: bigint;
  minSubmitsFunded?: number;
}

export function screenerChecks(options: ScreenerChecksOptions): Record<string, HealthCheck> {
  const minSubmits = BigInt(options.minSubmitsFunded ?? DEFAULT_MIN_SUBMITS_FUNDED);

  // A screener the registry does not recognise signs screenings nobody can
  // record, and every caller would be refused at funding with no clue why.
  const registered = async (): Promise<CheckResult> => {
    const ok = await options.publicClient.readContract({
      address: options.registry,
      abi: screeningRegistryAbi,
      functionName: "isScreener",
      args: [options.account],
    });
    return { ok, detail: ok ? `${options.account} is a registered screener` : `${options.registry} does not recognise ${options.account}` };
  };

  const balance = async (): Promise<CheckResult> => {
    const [held, gasPriceWei] = await Promise.all([
      options.publicClient.getBalance({ address: options.account }),
      options.publicClient.getGasPrice(),
    ]);
    const perSubmit = gasPriceWei * options.submitGas;
    if (perSubmit === 0n) return { ok: true, detail: `${held} wei for gas, and gas is free at the current price` };
    const covered = held / perSubmit;
    return {
      ok: covered >= minSubmits,
      detail: `${held} wei covers ${covered} submissions at ${gasPriceWei} wei per gas and ${options.submitGas} gas each, minimum ${minSubmits}`,
    };
  };

  return {
    rpc: { check: async () => ({ ok: (await options.publicClient.getChainId()) === options.chainId }), critical: true },
    registered: { check: registered, critical: true },
    balance: { check: balance, critical: true },
  };
}
