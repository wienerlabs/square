import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, arcTestnetWithRpc } from "../src/network.js";

export const ANVIL_PORT = 8560;
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const DEPLOYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const PAYER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const PAYEE_ADDRESS: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_ARTIFACT = join(HERE, "../../../contracts/out/MockUSDC3009.sol/MockUSDC3009.json");

export interface MockUsdcArtifact {
  abi: Abi;
  bytecode: Hex;
}

export function loadMockUsdcArtifact(): MockUsdcArtifact {
  let raw: string;
  try {
    raw = readFileSync(MOCK_ARTIFACT, "utf8");
  } catch {
    throw new Error(`MockUSDC3009 artifact missing at ${MOCK_ARTIFACT}; run "forge build" in contracts/ first`);
  }
  const parsed = JSON.parse(raw) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function rpcChainId(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result === undefined ? undefined : Number(body.result);
  } catch {
    return undefined;
  }
}

export interface AnvilHandle {
  rpcUrl: string;
  stop(): Promise<void>;
}

export async function startAnvil(): Promise<AnvilHandle> {
  const existing = await rpcChainId(ANVIL_RPC_URL);
  if (existing !== undefined) {
    throw new Error(`port ${ANVIL_PORT} already serves chain ${existing}; stop it before running the suite`);
  }
  const proc: ChildProcess = spawn(
    "anvil",
    ["--port", String(ANVIL_PORT), "--chain-id", String(ARC_TESTNET_CHAIN_ID), "--silent"],
    { stdio: "ignore" }
  );
  let exited = false;
  proc.on("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("anvil exited before serving RPC (is foundry installed?)");
    }
    const id = await rpcChainId(ANVIL_RPC_URL);
    if (id === ARC_TESTNET_CHAIN_ID) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if ((await rpcChainId(ANVIL_RPC_URL)) !== ARC_TESTNET_CHAIN_ID) {
    proc.kill("SIGKILL");
    throw new Error("anvil did not become ready on time");
  }
  return {
    rpcUrl: ANVIL_RPC_URL,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) proc.kill("SIGKILL");
        }, 3_000).unref();
      }),
  };
}

export interface LocalChain {
  chain: Chain;
  publicClient: PublicClient;
  deployerWallet: WalletClient<Transport, Chain, Account>;
  usdc: Address;
  abi: Abi;
}

export async function deployMockUsdc(rpcUrl: string, mintTo: Address, mintAmount: bigint): Promise<LocalChain> {
  const chain = arcTestnetWithRpc(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const { abi, bytecode } = loadMockUsdcArtifact();
  const deployHash = await deployerWallet.deployContract({ abi, bytecode, args: [] });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const usdc = deployReceipt.contractAddress;
  if (!usdc) {
    throw new Error("MockUSDC3009 deployment produced no contract address");
  }
  const mintHash = await deployerWallet.writeContract({
    address: usdc,
    abi,
    functionName: "mint",
    args: [mintTo, mintAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  return { chain, publicClient, deployerWallet, usdc, abi };
}
