import type { Address, PublicClient } from "viem";
import type { Database } from "@squaresdk/data";
import { DEFAULT_CHECK_TIMEOUT_MS, type CheckResult, type HealthCheck } from "@squaresdk/observability";
import { hookScreening, screenerFetch, type ScreenerEndpoint } from "./screening.js";

export const DEFAULT_MIN_ACTIONS_FUNDED = 3;

export interface KeeperChecksOptions {
  db: Pick<Database, "query">;
  publicClient: Pick<PublicClient, "getChainId" | "getBalance" | "getGasPrice" | "readContract">;
  chainId: number;
  account: Address;
  hook: Address;
  finalizeGas: bigint;
  minActionsFunded?: number;
  ephemeralMirror: boolean;
  /**
   * square#35. Set when SCREENER_URL is, and then every release on a hook that
   * screens waits on the screener. A screener that is down, or whose own
   * `/health` fails because its registry does not recognise it or it cannot pay
   * for a submission, holds every such release while the other checks stay
   * green; so the check is critical.
   */
  screener?: ScreenerEndpoint;
}

export function keeperChecks(options: KeeperChecksOptions): Record<string, HealthCheck> {
  const minActions = BigInt(options.minActionsFunded ?? DEFAULT_MIN_ACTIONS_FUNDED);

  const screenerHealth = async (endpoint: ScreenerEndpoint): Promise<CheckResult> => {
    const response = await screenerFetch(endpoint, "/health", { method: "GET" }, DEFAULT_CHECK_TIMEOUT_MS);
    const body = await response.text();
    if (response.ok) return { ok: true, detail: `${endpoint.url} reports itself healthy` };
    let failing: string[] = [];
    try {
      const { checks } = JSON.parse(body) as { checks?: Record<string, { ok?: boolean }> };
      failing = Object.entries(checks ?? {})
        .filter(([, report]) => report.ok !== true)
        .map(([name]) => name);
    } catch {
      // Not a health report; the status is all there is to say.
    }
    return { ok: false, detail: `${endpoint.url}/health answered ${response.status}${failing.length > 0 ? `, failing: ${failing.join(", ")}` : ""}` };
  };
  const screener = options.screener;

  const screensWithoutAScreener = async (): Promise<CheckResult> => {
    const registry = await hookScreening(options.publicClient, options.hook);
    return registry === undefined
      ? { ok: true, detail: `${options.hook} screens nobody, so no screener is needed` }
      : {
          ok: false,
          detail:
            `${options.hook} screens with ${registry} and SCREENER_URL is not set: ` +
            "every release on it would be refused and pay the client instead of the provider",
        };
  };

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
    ...(screener
      ? { screener: { check: () => screenerHealth(screener), critical: true } }
      : { screening: { check: screensWithoutAScreener, critical: true } }),
  };
}
