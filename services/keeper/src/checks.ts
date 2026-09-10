import type { Address, PublicClient } from "viem";
import type { Database } from "@squaresdk/data";
import type { CheckResult, HealthCheck } from "@squaresdk/observability";

export const DEFAULT_MIN_ACTIONS_FUNDED = 3;

export interface KeeperChecksOptions {
  db: Pick<Database, "query">;
  publicClient: Pick<PublicClient, "getChainId" | "getBalance" | "getGasPrice">;
  chainId: number;
  account: Address;
  finalizeGas: bigint;
  minActionsFunded?: number;
  ephemeralMirror: boolean;
}

export function keeperChecks(options: KeeperChecksOptions): Record<string, HealthCheck> {
  const minActions = BigInt(options.minActionsFunded ?? DEFAULT_MIN_ACTIONS_FUNDED);

  const balance = async (): Promise<CheckResult> => {
    const [balance, gasPriceWei] = await Promise.all([
      options.publicClient.getBalance({ address: options.account }),
      options.publicClient.getGasPrice(),
    ]);
    const perAction = gasPriceWei * options.finalizeGas;
    if (perAction === 0n) {
      return { ok: true, detail: `${balance} wei of native USDC for gas, and gas is free at the current price` };
    }
    const covered = balance / perAction;
    return {
      ok: covered >= minActions,
      detail:
        `${balance} wei of native USDC covers ${covered} finalize sends ` +
        `at ${gasPriceWei} wei per gas and ${options.finalizeGas} gas each, minimum ${minActions}`,
    };
  };

  return {
    database: { check: async () => ({ ok: (await options.db.query("select 1")).rowCount === 1 }), critical: true },
    rpc: { check: async () => ({ ok: (await options.publicClient.getChainId()) === options.chainId }), critical: true },
    balance: { check: balance, critical: true },
    mirror: () => ({
      ok: !options.ephemeralMirror,
      detail: options.ephemeralMirror
        ? "DATABASE_URL is not set, the mirror is private to this process and stays empty"
        : "reading the mirror an indexer writes",
    }),
  };
}
