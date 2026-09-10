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
 *
 * Every field is validated here, with the variable's name in the error, so a
 * typo fails at boot in the driver's own words. The two numbers matter most:
 * Number("abc") is NaN, and NaN reaches setTimeout as a 1 ms timeout, which
 * would abort every agentURI fetch while /health kept saying ok.
 */
export interface DriverConfig {
  port: number;
  rpc: Record<number, string>;
  allowedRegistries: string[] | undefined;
  timeoutMs: number;
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 10_000;

function chainId(raw: string, source: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${source}: "${raw}" is not a chain id`);
  return id;
}

function positiveInteger(raw: string | undefined, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined) return fallback;
  // Number() rather than parseInt(): "80abc" must fail, not read as 80.
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(`${name}: "${raw}" is not a whole number from 1 to ${max}`);
  }
  return n;
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
      throw new Error('DRIVER_RPC must be an object, e.g. {"<chainId>":"https://..."}');
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = chainId(k, "DRIVER_RPC");
      if (typeof v !== "string" || !v) throw new Error(`DRIVER_RPC: chain ${k} has no endpoint`);
      rpc[id] = v;
    }
  }

  // The winning form gets the same check as the losing one. RPC_0 used to
  // pass here while {"0": ...} was refused above.
  for (const [k, v] of Object.entries(env)) {
    const m = /^RPC_(\d+)$/.exec(k);
    if (m && typeof v === "string" && v) rpc[chainId(m[1]!, k)] = v;
  }

  if (Object.keys(rpc).length === 0) {
    throw new Error(
      "No chains configured. Set DRIVER_RPC or RPC_<chainId>, " +
        "e.g. RPC_<chainId>=https://your-endpoint"
    );
  }

  const allow = env.DRIVER_ALLOWED_REGISTRIES?.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    port: positiveInteger(env.DRIVER_PORT, "DRIVER_PORT", DEFAULT_PORT, 65_535),
    rpc,
    allowedRegistries: allow && allow.length > 0 ? allow : undefined,
    timeoutMs: positiveInteger(env.DRIVER_TIMEOUT_MS, "DRIVER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };
}
