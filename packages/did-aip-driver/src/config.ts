/**
 * Chain configuration from the environment.
 *
 * The v1 driver took a single SOLANA_RPC_URL because there was one chain. v2
 * resolves across EVM chains, so the driver takes a map. Two forms:
 *
 *   DRIVER_RPC='{"5042002":"https://rpc.testnet.arc.io"}'
 *   RPC_5042002=https://rpc.testnet.arc.io
 *
 * The per-chain variables are easier to set in a container platform's UI; the
 * JSON form is easier in compose. Both may be used, and the per-chain
 * variables win, because an operator overriding one chain should not have to
 * restate the whole map.
 */
export interface DriverConfig {
  port: number;
  rpc: Record<number, string>;
  allowedRegistries: string[] | undefined;
  timeoutMs: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  const rpc: Record<number, string> = {};

  if (env.DRIVER_RPC) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.DRIVER_RPC);
    } catch {
      throw new Error("DRIVER_RPC is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error('DRIVER_RPC must be an object, e.g. {"5042002":"https://..."}');
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`DRIVER_RPC: "${k}" is not a chain id`);
      if (typeof v !== "string" || !v) throw new Error(`DRIVER_RPC: chain ${k} has no endpoint`);
      rpc[id] = v;
    }
  }

  for (const [k, v] of Object.entries(env)) {
    const m = /^RPC_(\d+)$/.exec(k);
    if (m && typeof v === "string" && v) rpc[Number(m[1])] = v;
  }

  if (Object.keys(rpc).length === 0) {
    throw new Error(
      "No chains configured. Set DRIVER_RPC or RPC_<chainId>, " +
        "e.g. RPC_5042002=https://rpc.testnet.arc.io"
    );
  }

  const allow = env.DRIVER_ALLOWED_REGISTRIES?.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    port: Number(env.DRIVER_PORT ?? 8080),
    rpc,
    allowedRegistries: allow && allow.length > 0 ? allow : undefined,
    timeoutMs: Number(env.DRIVER_TIMEOUT_MS ?? 10_000),
  };
}
