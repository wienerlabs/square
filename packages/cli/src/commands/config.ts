import { Command } from "commander";
import { loadConfig, resolveNetwork, saveConfig } from "../core/config.js";
import { ValidationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { c } from "../core/theme.js";
import { paths } from "../core/paths.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function chainIdArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`'${value}' is not a chain id`);
  return n;
}

export function configCommand(): Command {
  const cmd = new Command("config").description("Inspect and change the network configuration");

  cmd
    .command("show", { isDefault: true })
    .description("Print the effective configuration")
    .action(async () => {
      const config = await loadConfig();
      const network = resolveNetwork(config);
      log.blank();
      log.field("file", paths.configFile());
      log.field("chain", `${network.name} (${network.chainId})`);
      log.field("rpc", network.rpcUrl);
      log.field("registry", network.identityRegistry);
      log.field("timeout", `${config.timeoutMs} ms`);
      const overrides = Object.entries(config.rpc);
      if (overrides.length > 0) {
        log.blank();
        log.raw(`  ${c.dim("RPC overrides")}`);
        for (const [id, url] of overrides) log.field(id, url);
      }
      const registries = Object.entries(config.registry);
      if (registries.length > 0) {
        log.blank();
        log.raw(`  ${c.dim("Registry overrides")}`);
        for (const [id, addr] of registries) log.field(id, addr);
      }
      log.blank();
    });

  cmd
    .command("use-chain <chainId>")
    .description("Set the chain that 'register' writes to")
    .action(async (raw: string) => {
      const chainId = chainIdArg(raw);
      const config = await saveConfig({ chainId });
      // Resolving afterwards turns "saved" into "saved and usable": a chain with
      // no endpoint would otherwise only fail at the next command.
      const network = resolveNetwork(config, { chainId });
      log.success(`Active chain is now ${network.name} (${network.chainId}).`);
    });

  cmd
    .command("set-rpc <chainId> <url>")
    .description("Set the RPC endpoint for a chain")
    .action(async (raw: string, url: string) => {
      const chainId = chainIdArg(raw);
      const config = await loadConfig();
      await saveConfig({ rpc: { ...config.rpc, [String(chainId)]: url } });
      log.success(`RPC for chain ${chainId} set to ${url}.`);
    });

  cmd
    .command("set-registry <chainId> <address>")
    .description("Set the ERC-8004 IdentityRegistry address for a chain")
    .action(async (raw: string, address: string) => {
      const chainId = chainIdArg(raw);
      if (!ADDRESS.test(address)) throw new ValidationError(`'${address}' is not a 20-byte address`);
      const config = await loadConfig();
      await saveConfig({ registry: { ...config.registry, [String(chainId)]: address } });
      log.success(`Registry for chain ${chainId} set to ${address}.`);
    });

  return cmd;
}
