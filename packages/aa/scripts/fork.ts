import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_CHAIN_ID } from "../src/constants.js";

export const ARC_TESTNET_FORK_URL = "https://rpc.testnet.arc.io";

export const DEFAULT_FORK_PORT = 8561;

export const forkChain: Chain = arcTestnet;

const here = dirname(fileURLToPath(import.meta.url));

export const packageRoot = resolve(here, "..");

export const repoRoot = resolve(packageRoot, "..", "..");

export const contractsDir = join(repoRoot, "contracts");

/**
 * The record of the real Arc Testnet deployment, in version control. Nothing
 * in this harness writes it or removes it (#270): the fork answers with Arc's
 * chain id, so the deploy script's default path would be this file, and one
 * `npm test` here used to leave the working tree without it.
 */
export const arcDeploymentFile = join(contractsDir, "deployments", `${ARC_TESTNET_CHAIN_ID}.json`);

/** Relative to `contracts/`, the way the deploy script takes it in DEPLOYMENT_FILE. */
export const forkDeploymentPath = `deployments/${ARC_TESTNET_CHAIN_ID}.local.json`;

/** Where the fork's mock stack is recorded: next to the record, and ignored by git. */
export const forkDeploymentFile = join(contractsDir, forkDeploymentPath);

export const broadcastDir = join(contractsDir, "broadcast", "DeployLocal.s.sol", String(ARC_TESTNET_CHAIN_ID));

export const anvilPrivateKeys: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

export function anvilAccount(index: number): PrivateKeyAccount {
  const key = anvilPrivateKeys[index];
  if (!key) throw new Error(`no anvil key at index ${index}`);
  return privateKeyToAccount(key);
}

export type SquareDeployment = {
  chainId: number;
  SquareJob: Address;
  KeeperEvaluator: Address;
  Arbitration: Address;
  ClaimMarket: Address;
  SquareHook: Address;
  USDC: Address;
  IdentityRegistry: Address;
  ReputationRegistry: Address;
  ValidationRegistry: Address;
};

const deploymentAddressKeys = [
  "SquareJob",
  "KeeperEvaluator",
  "Arbitration",
  "ClaimMarket",
  "SquareHook",
  "USDC",
  "IdentityRegistry",
  "ReputationRegistry",
  "ValidationRegistry",
] as const;

export type ForkHandle = {
  rpcUrl: string;
  port: number;
  stop: () => void;
};

export type StartAnvilForkOptions = {
  port?: number | undefined;
  forkUrl?: string | undefined;
  timeoutMs?: number | undefined;
  attempts?: number | undefined;
};

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function rpcChainId(rpcUrl: string): Promise<number | undefined> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await response.json()) as { result?: string };
    return body.result ? Number.parseInt(body.result, 16) : undefined;
  } catch {
    return undefined;
  }
}

async function spawnAnvilFork(port: number, forkUrl: string, timeoutMs: number): Promise<ForkHandle> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "anvil",
    ["--port", String(port), "--chain-id", String(ARC_TESTNET_CHAIN_ID), "--fork-url", forkUrl, "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const stop = (): void => {
    if (!exited) child.kill("SIGTERM");
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`anvil exited before serving ${rpcUrl}\n${stderr}`);
    if ((await rpcChainId(rpcUrl)) === ARC_TESTNET_CHAIN_ID) return { rpcUrl, port, stop };
    await sleep(250);
  }
  stop();
  throw new Error(`anvil fork of ${forkUrl} did not answer eth_chainId within ${timeoutMs}ms\n${stderr}`);
}

export async function startAnvilFork(options: StartAnvilForkOptions = {}): Promise<ForkHandle> {
  const { port = DEFAULT_FORK_PORT, forkUrl = ARC_TESTNET_FORK_URL, timeoutMs = 90_000, attempts = 2 } = options;
  const rpcUrl = `http://127.0.0.1:${port}`;
  if ((await rpcChainId(rpcUrl)) !== undefined) {
    throw new Error(`port ${port} is already serving JSON-RPC; stop it before starting the Arc fork`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await spawnAnvilFork(port, forkUrl, timeoutMs);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fundNative(rpcUrl: string, addresses: readonly Address[], value = parseEther("1000")): Promise<void> {
  const testClient = createTestClient({ chain: forkChain, mode: "anvil", transport: http(rpcUrl) });
  for (const address of addresses) await testClient.setBalance({ address, value });
}

export function parseDeployment(raw: unknown): SquareDeployment {
  if (typeof raw !== "object" || raw === null) throw new Error("deployment file is not an object");
  const record = raw as Record<string, unknown>;
  const chainId = Number(record["chainId"]);
  if (chainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`deployment chainId ${chainId} is not ${ARC_TESTNET_CHAIN_ID}`);
  const deployment: Record<string, Address | number> = { chainId };
  for (const key of deploymentAddressKeys) {
    const value = record[key];
    if (typeof value !== "string" || !isAddress(value)) throw new Error(`deployment is missing ${key}`);
    deployment[key] = value;
  }
  return deployment as SquareDeployment;
}

export function removeLocalDeploymentArtifacts(): void {
  rmSync(forkDeploymentFile, { force: true });
  rmSync(broadcastDir, { recursive: true, force: true });
}

type Artifact = { abi: Abi; bytecode: Hex };

export function loadArtifact(source: string, contract = source): Artifact {
  const file = join(contractsDir, "out", `${source}.sol`, `${contract}.json`);
  if (!existsSync(file)) throw new Error(`missing compiled artifact ${file}; run forge build in contracts/`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

export const ONE_DAY = 86_400;

export async function deployFromArtifacts(rpcUrl: string): Promise<SquareDeployment> {
  const deployer = anvilAccount(0);
  await fundNative(rpcUrl, [deployer.address]);
  const publicClient = createPublicClient({ chain: forkChain, transport: http(rpcUrl), pollingInterval: 50 });
  const wallet = createWalletClient({ chain: forkChain, transport: http(rpcUrl), account: deployer, pollingInterval: 50 });

  const deploy = async (source: string, contract: string, args: readonly unknown[] = []): Promise<Address> => {
    const { abi, bytecode } = loadArtifact(source, contract);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploying ${contract} failed in ${hash}`);
    return getAddress(receipt.contractAddress);
  };
  const call = async (
    address: Address,
    source: string,
    contract: string,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> => {
    const { abi } = loadArtifact(source, contract);
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${contract}.${functionName} reverted in ${hash}`);
  };

  const usdc = await deploy("MockUSDC3009", "MockUSDC3009");
  const identity = await deploy("MockRegistries", "MockIdentityRegistry");
  const reputation = await deploy("MockRegistries", "MockReputationRegistry");
  const validation = await deploy("MockRegistries", "MockValidationRegistry");
  const kernel = await deploy("SquareJob", "SquareJob", [usdc, deployer.address, 100, 50, 1_000_000n, deployer.address]);
  const keeper = await deploy("KeeperEvaluator", "KeeperEvaluator", [kernel, deployer.address, ONE_DAY, 3 * ONE_DAY]);
  const arbitration = await deploy("Arbitration", "Arbitration", [keeper, deployer.address, 1_000, 1_000_000n]);
  const market = await deploy("ClaimMarket", "ClaimMarket", [kernel, keeper]);
  const hook = await deploy("SquareHook", "SquareHook", [
    kernel,
    market,
    identity,
    reputation,
    validation,
    deployer.address,
  ]);
  await call(keeper, "KeeperEvaluator", "KeeperEvaluator", "setArbitration", [arbitration]);
  await call(kernel, "SquareJob", "SquareJob", "setHookWhitelist", [hook, true]);
  await call(arbitration, "Arbitration", "Arbitration", "setArbiters", [
    [anvilAccount(4).address, anvilAccount(5).address, anvilAccount(6).address],
    2,
  ]);
  await call(usdc, "MockUSDC3009", "MockUSDC3009", "mint", [anvilAccount(1).address, 1_000_000_000_000n]);
  await call(usdc, "MockUSDC3009", "MockUSDC3009", "mint", [anvilAccount(3).address, 1_000_000_000_000n]);
  await call(usdc, "MockUSDC3009", "MockUSDC3009", "mint", [anvilAccount(2).address, 1_000_000_000n]);
  await call(identity, "MockRegistries", "MockIdentityRegistry", "setAgent", [
    1n,
    anvilAccount(2).address,
    anvilAccount(2).address,
  ]);

  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    SquareJob: kernel,
    KeeperEvaluator: keeper,
    Arbitration: arbitration,
    ClaimMarket: market,
    SquareHook: hook,
    USDC: usdc,
    IdentityRegistry: identity,
    ReputationRegistry: reputation,
    ValidationRegistry: validation,
  };
}

export async function deployWithForgeScript(rpcUrl: string): Promise<SquareDeployment> {
  await fundNative(rpcUrl, [anvilAccount(0).address]);
  const env = { ...process.env };
  delete env["DEPLOYER_PRIVATE_KEY"];
  // DeployLocal deploys mocks and refuses any chain but 31337 unless the caller
  // names the one it means (square#232). This fork answers with Arc's chain id
  // and is ours: spawned above. Where the script writes is named as well: its
  // default for this chain id is the committed Arc Testnet record, and the
  // script refuses that path on any chain but 31337 (#270). The file it does
  // write is gitignored, and `removeLocalDeploymentArtifacts` deletes it along
  // with the broadcast log.
  env["DEPLOY_LOCAL_ALLOW_CHAIN_ID"] = String(ARC_TESTNET_CHAIN_ID);
  env["DEPLOYMENT_FILE"] = forkDeploymentPath;
  try {
    execSync(`forge script script/DeployLocal.s.sol --rpc-url ${rpcUrl} --broadcast --slow`, {
      cwd: contractsDir,
      env,
      stdio: "pipe",
      timeout: 300_000,
    });
    return parseDeployment(JSON.parse(readFileSync(forkDeploymentFile, "utf8")));
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new Error(`forge script DeployLocal failed against ${rpcUrl}\n${detail}`);
  } finally {
    removeLocalDeploymentArtifacts();
  }
}

export async function deploySquareStack(rpcUrl: string): Promise<SquareDeployment> {
  if (process.env["AA_DEPLOY_FROM_ARTIFACTS"] === "1") return deployFromArtifacts(rpcUrl);
  return deployWithForgeScript(rpcUrl);
}
