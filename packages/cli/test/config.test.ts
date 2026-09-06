import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARC_TESTNET_ID } from "../src/core/chains.js";
import { ConfigSchema, loadConfig, resolveNetwork, rpcMap, saveConfig } from "../src/core/config.js";

const ENV_KEYS = ["SQUARE_HOME", "SQUARE_CHAIN_ID", "SQUARE_RPC_URL", "SQUARE_REGISTRY"] as const;

describe("configuration", () => {
  let sandbox: string;
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "square-cfg-test-"));
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SQUARE_HOME = sandbox;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  it("defaults to Arc testnet with no config file at all", async () => {
    const network = resolveNetwork(await loadConfig());
    expect(network.chainId).toBe(ARC_TESTNET_ID);
    expect(network.name).toBe("Arc Testnet");
    expect(network.rpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(network.identityRegistry).toBe("0x8004a818bfb912233c491871b3d84c89a494bd9e");
    expect(network.nativeCurrency.symbol).toBe("USDC");
  });

  it("lowercases a registry override, because a DID string carries it lowercase", () => {
    const network = resolveNetwork(ConfigSchema.parse({}), {
      registry: "0x8004A818BFB912233C491871B3D84C89A494BD9E",
    });
    expect(network.identityRegistry).toBe("0x8004a818bfb912233c491871b3d84c89a494bd9e");
  });

  it("refuses a chain it neither knows nor has an endpoint for", () => {
    expect(() => resolveNetwork(ConfigSchema.parse({}), { chainId: 424242 })).toThrow(/No RPC/);
  });

  it("refuses a configured chain with no registry, rather than guessing one", () => {
    const config = ConfigSchema.parse({ rpc: { "424242": "https://rpc.example" } });
    expect(() => resolveNetwork(config, { chainId: 424242 })).toThrow(/IdentityRegistry/);
  });

  it("accepts an unknown chain once both halves are supplied", () => {
    const config = ConfigSchema.parse({ rpc: { "424242": "https://rpc.example" } });
    const network = resolveNetwork(config, {
      chainId: 424242,
      registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
    });
    expect(network.rpcUrl).toBe("https://rpc.example");
    expect(network.name).toBe("chain 424242");
  });

  it("lets a flag beat the environment", async () => {
    process.env.SQUARE_RPC_URL = "https://from-env.example";
    const config = await loadConfig();
    expect(resolveNetwork(config).rpcUrl).toBe("https://from-env.example");
    expect(resolveNetwork(config, { rpc: "https://from-flag.example" }).rpcUrl).toBe(
      "https://from-flag.example",
    );
  });

  it("applies SQUARE_RPC_URL to the chain SQUARE_CHAIN_ID selects", async () => {
    process.env.SQUARE_CHAIN_ID = "424242";
    process.env.SQUARE_RPC_URL = "https://other-chain.example";
    process.env.SQUARE_REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
    const network = resolveNetwork(await loadConfig());
    expect(network.chainId).toBe(424242);
    expect(network.rpcUrl).toBe("https://other-chain.example");
  });

  it("rejects a SQUARE_CHAIN_ID that is not a chain id", async () => {
    process.env.SQUARE_CHAIN_ID = "not-a-number";
    await expect(loadConfig()).rejects.toThrow(/SQUARE_CHAIN_ID/);
  });

  it("round-trips through the config file at mode 0600", async () => {
    await saveConfig({ chainId: ARC_TESTNET_ID, rpc: { "5042002": "https://mine.example" } });
    const config = await loadConfig();
    expect(resolveNetwork(config).rpcUrl).toBe("https://mine.example");
  });

  it("reports an unreadable config file instead of silently using defaults", async () => {
    await writeFile(join(sandbox, "config.json"), "{ not json");
    await expect(loadConfig()).rejects.toThrow(/Could not read/);
  });

  it("keeps every known chain in the resolver map, not just the active one", () => {
    // `resolve` takes the chain from the DID, so a DID on an inactive but
    // configured chain must still resolve.
    const config = ConfigSchema.parse({ chainId: 1, rpc: { "1": "https://mainnet.example" } });
    const map = rpcMap(config);
    expect(map[ARC_TESTNET_ID]).toBe("https://rpc.testnet.arc.io");
    expect(map[1]).toBe("https://mainnet.example");
  });

  it("lets a config override beat the built-in endpoint for a known chain", () => {
    const config = ConfigSchema.parse({ rpc: { "5042002": "https://my-arc-node.example" } });
    expect(rpcMap(config)[ARC_TESTNET_ID]).toBe("https://my-arc-node.example");
  });
});
