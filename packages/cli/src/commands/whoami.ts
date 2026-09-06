import { Command } from "commander";
import { createPublicClient, formatUnits, http } from "viem";
import { loadConfig, resolveNetwork } from "../core/config.js";
import { log } from "../core/logger.js";
import { c } from "../core/theme.js";
import { keystoreAddress } from "../core/unlock.js";
import { paths } from "../core/paths.js";

interface WhoamiOpts {
  chainId?: number;
  rpc?: string;
  json?: boolean;
}

export function whoamiCommand(): Command {
  return new Command("whoami")
    .description("Show the wallet address, the active network, and the balance")
    .option("--chain-id <n>", "Override the chain id", (v) => Number(v))
    .option("--rpc <url>", "Override the RPC endpoint")
    .option("--json", "Machine-readable output")
    .action(async (opts: WhoamiOpts) => {
      const config = await loadConfig();
      const network = resolveNetwork(config, {
        chainId: opts.chainId,
        rpc: opts.rpc,
      });
      const address = await keystoreAddress();

      let balance: bigint | null = null;
      let balanceError: string | null = null;
      if (address) {
        try {
          const client = createPublicClient({ transport: http(network.rpcUrl) });
          balance = await client.getBalance({ address: address as `0x${string}` });
        } catch (err) {
          // Not being able to reach an RPC is not a reason to withhold the
          // address, which is the answer to the question actually asked.
          balanceError = err instanceof Error ? err.message : String(err);
        }
      }

      if (opts.json) {
        log.out(
          JSON.stringify(
            {
              address,
              keystore: paths.keystoreFile(),
              chainId: network.chainId,
              network: network.name,
              rpcUrl: network.rpcUrl,
              identityRegistry: network.identityRegistry,
              balance: balance === null ? null : balance.toString(),
              balanceFormatted:
                balance === null ? null : formatUnits(balance, network.nativeCurrency.decimals),
              symbol: network.nativeCurrency.symbol,
              ...(balanceError ? { balanceError } : {}),
            },
            null,
            2,
          ),
        );
        return;
      }

      log.blank();
      if (!address) {
        log.warn("No wallet. Run 'mandate login' to create or import one.");
      } else {
        log.field("address", c.cyan(address));
        log.field("keystore", paths.keystoreFile());
      }
      log.field("network", `${network.name} (chain ${network.chainId})`);
      log.field("rpc", network.rpcUrl);
      log.field("registry", network.identityRegistry);
      if (balance !== null) {
        log.field(
          "balance",
          `${formatUnits(balance, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`,
        );
        if (balance === 0n) {
          log.blank();
          log.warn(
            `This wallet holds no ${network.nativeCurrency.symbol}. ` +
              "Registration needs gas — fund the address before running 'mandate register'.",
          );
        }
      } else if (balanceError) {
        log.field("balance", c.dim(`unavailable (${balanceError})`));
      }
      log.blank();
    });
}
