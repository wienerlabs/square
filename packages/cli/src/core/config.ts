import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { paths, ensureRoot } from "./paths.js";
import { ConfigError, ValidationError } from "./errors.js";
import {
  DEFAULT_CHAIN_ID,
  KNOWN_CHAINS,
  type KnownChain,
  type Network,
} from "./chains.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const ConfigSchema = z.object({
  /** The chain `register` writes to, and the default for `resolve`. */
  chainId: z.number().int().positive().default(DEFAULT_CHAIN_ID),
  /**
   * chainId -> RPC endpoint. A map rather than one URL because `resolve` takes
   * the chain from the DID, not from the config: resolving a DID on a chain you
   * do not register on is the normal case, not an exotic one.
   */
  rpc: z.record(z.string(), z.string().url()).default({}),
  /** chainId -> IdentityRegistry override. */
  registry: z.record(z.string(), z.string().regex(ADDRESS)).default({}),
  timeoutMs: z.number().int().positive().default(15_000),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULTS: Config = ConfigSchema.parse({});

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readRaw(): Promise<Partial<Config>> {
  try {
    return JSON.parse(await readFile(paths.configFile(), "utf8")) as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(
      `Could not read ${paths.configFile()}`,
      "Fix the JSON or delete the file to fall back to defaults.",
    );
  }
}

/**
 * Environment overrides. SQUARE_RPC_URL and SQUARE_REGISTRY apply to the
 * active chain only — they are the single-chain shorthand, and writing them
 * into the map keeps one code path downstream.
 */
function withEnvOverrides(config: Config): Config {
  const rawChain = nonEmpty(process.env.SQUARE_CHAIN_ID);
  let chainId = config.chainId;
  if (rawChain !== undefined) {
    const parsed = Number(rawChain);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigError(`SQUARE_CHAIN_ID is not a chain id: ${rawChain}`);
    }
    chainId = parsed;
  }

  const rpc = { ...config.rpc };
  const rpcUrl = nonEmpty(process.env.SQUARE_RPC_URL);
  if (rpcUrl) rpc[String(chainId)] = rpcUrl;

  const registry = { ...config.registry };
  const registryOverride = nonEmpty(process.env.SQUARE_REGISTRY);
  if (registryOverride) {
    if (!ADDRESS.test(registryOverride)) {
      throw new ConfigError(`SQUARE_REGISTRY is not an address: ${registryOverride}`);
    }
    registry[String(chainId)] = registryOverride;
  }

  return { ...config, chainId, rpc, registry };
}

export async function loadConfig(): Promise<Config> {
  const raw = await readRaw();
  const parsed = ConfigSchema.safeParse({ ...DEFAULTS, ...raw });
  if (!parsed.success) {
    throw new ConfigError(
      `Config file is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      `Delete ${paths.configFile()} to fall back to defaults.`,
    );
  }
  return withEnvOverrides(parsed.data);
}

export async function saveConfig(next: Partial<Config>): Promise<Config> {
  const current = await readRaw();
  const parsed = ConfigSchema.safeParse({ ...DEFAULTS, ...current, ...next });
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config update: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  await ensureRoot();
  const target = paths.configFile();
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
  return withEnvOverrides(parsed.data);
}

export interface NetworkOverrides {
  chainId?: number | undefined;
  rpc?: string | undefined;
  registry?: string | undefined;
}

/**
 * Flags beat environment beats config file beats the built-in table.
 *
 * A chain that is neither known nor fully configured is a hard error rather
 * than a guess: registering against the wrong registry address mints a real
 * token under an identifier nobody can resolve.
 */
export function resolveNetwork(config: Config, overrides: NetworkOverrides = {}): Network {
  const chainId = overrides.chainId ?? config.chainId;
  const known: KnownChain | undefined = KNOWN_CHAINS[chainId];

  const rpcUrl = overrides.rpc ?? config.rpc[String(chainId)] ?? known?.rpcUrl;
  if (!rpcUrl) {
    throw new ConfigError(
      `No RPC endpoint for chain ${chainId}`,
      `Pass --rpc <url>, set SQUARE_RPC_URL, or run: square config set-rpc ${chainId} <url>`,
    );
  }

  const registryRaw = overrides.registry ?? config.registry[String(chainId)] ?? known?.identityRegistry;
  if (!registryRaw) {
    throw new ConfigError(
      `No ERC-8004 IdentityRegistry known for chain ${chainId}`,
      `Pass --registry <address>, or run: square config set-registry ${chainId} <address>`,
    );
  }
  if (!ADDRESS.test(registryRaw)) {
    throw new ValidationError(`Registry '${registryRaw}' is not a 20-byte address`);
  }

  return {
    chainId,
    name: known?.name ?? `chain ${chainId}`,
    rpcUrl,
    // Lowercase: a did:aip v2 string carries the registry in lowercase, and DID
    // equality is string equality (method spec section 3.2).
    identityRegistry: registryRaw.toLowerCase() as `0x${string}`,
    explorer: known?.explorer,
    nativeCurrency: known?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
  };
}

/**
 * Every endpoint the resolver may use, keyed by chain id.
 *
 * `resolve` reads the chain from the DID, so it needs the whole map — not just
 * the active chain — or a DID on a configured-but-inactive chain would come
 * back `unsupportedChain`.
 */
export function rpcMap(config: Config): Record<number, string> {
  const map: Record<number, string> = {};
  for (const chain of Object.values(KNOWN_CHAINS)) map[chain.id] = chain.rpcUrl;
  for (const [id, url] of Object.entries(config.rpc)) {
    const n = Number(id);
    if (Number.isInteger(n) && n > 0) map[n] = url;
  }
  return map;
}
