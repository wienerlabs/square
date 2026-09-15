import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSquareClient, deploymentFor, deploymentFromJson, type SquareClient, type SquareDeployment } from "@squaresdk/core";
import { ARTIFACT_FILES } from "../../src/local-prover.js";

/**
 * The compliance stack the anvil suites of this package, the CLI, the MCP
 * bridge and the hosted agent run against: DeployLocal plus a module keyed
 * to the proving key (scripts/install-module-for-this-build.mjs), and that
 * key's files, which the suites prove with in their own process (square#347).
 * Any of the three missing and the suite is skipped the way packages/core's
 * anvil suite skips without anvil.
 *
 *   ANVIL_RPC_URL            http://127.0.0.1:8545
 *   SQUARE_DEPLOYMENT_FILE   contracts/deployments/31337.json
 *   SQUARE_PROVER_ARTIFACTS  PROVER_ARTIFACTS_DIR, else services/prover/artifacts: the directory the module was keyed from
 */
export const rpcUrl = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
export const artifacts = process.env["SQUARE_PROVER_ARTIFACTS"] ?? process.env["PROVER_ARTIFACTS_DIR"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "services", "prover", "artifacts");
const MNEMONIC = "test test test test test test test test test test test junk";
export const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

export function localDeployment(): SquareDeployment {
  const file = process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contracts", "deployments", "31337.json");
  return existsSync(file) ? deploymentFromJson(JSON.parse(readFileSync(file, "utf8"))) : deploymentFor(31337);
}

async function reachable(url: string, body: string, expect: (json: unknown) => boolean): Promise<boolean> {
  try {
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body } : {}) });
    return expect(await response.json());
  } catch {
    return false;
  }
}

export interface Stack {
  deployment: SquareDeployment;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  /** A SquareClient signing as anvil account `index`. */
  actor(index: number): SquareClient;
}

/** The stack, or null with the reason it is not there. */
export async function complianceStack(): Promise<{ stack: Stack } | { skipped: string }> {
  if (!(await reachable(rpcUrl, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), (j) => (j as { result?: string }).result === "0x7a69"))) {
    return { skipped: `no anvil at ${rpcUrl}` };
  }
  const missing = Object.values(ARTIFACT_FILES).filter((file) => !existsSync(join(artifacts, file)));
  if (missing.length > 0) return { skipped: `no proving artifacts at ${artifacts}: ${missing.join(", ")} missing` };
  const deployment = localDeployment();
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  const actor = (index: number) => createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(index) }) });
  if ((await actor(0).complianceModule()) === null) return { skipped: `the stack at ${rpcUrl} has no compliance module installed (scripts/install-module-for-this-build.mjs)` };
  return { stack: { deployment, publicClient, testClient, actor } };
}
