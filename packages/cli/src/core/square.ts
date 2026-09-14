import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from "viem";
import { createSquareClient, deploymentFor, deploymentFromJson, type SquareClient, type SquareDeployment } from "@squaresdk/core";
import { toViemChain, type Network } from "./chains.js";
import { ConfigError, ValidationError } from "./errors.js";
import { unlockWallet } from "./unlock.js";

/**
 * The Square deployment the policy commands talk to.
 *
 * `--deployment <file>`, then `SQUARE_DEPLOYMENT_FILE`, then the SDK's own
 * table for the chain: the same order the services read it in
 * (docs/deploy/README.md), so a local stack is named the same way everywhere.
 */
export function deploymentForNetwork(network: Network, file: string | undefined): SquareDeployment {
  const path = file ?? process.env["SQUARE_DEPLOYMENT_FILE"]?.trim();
  if (path) {
    if (!existsSync(path)) throw new ConfigError(`No deployment file at ${path}`);
    const deployment = deploymentFromJson(JSON.parse(readFileSync(path, "utf8")));
    if (deployment.chainId !== network.chainId) {
      throw new ValidationError(`${path} is for chain ${deployment.chainId}, the network is chain ${network.chainId}`);
    }
    return deployment;
  }
  try {
    return deploymentFor(network.chainId);
  } catch {
    throw new ConfigError(
      `No Square deployment is known for chain ${network.chainId}`,
      "Pass --deployment <contracts/deployments/<chainId>.json>, or set SQUARE_DEPLOYMENT_FILE.",
    );
  }
}

export function readOnlySquare(network: Network, deployment: SquareDeployment): SquareClient {
  const publicClient = createPublicClient({ chain: toViemChain(network), transport: http(network.rpcUrl) }) as PublicClient;
  return createSquareClient({ publicClient, deployment });
}

/** A client that signs, unlocked the way `square register` unlocks: the keystore, or SQUARE_PRIVATE_KEY unattended. */
export async function signingSquare(network: Network, deployment: SquareDeployment, prompt: string): Promise<{ client: SquareClient; address: Address }> {
  const wallet = await unlockWallet({ prompt });
  const chain = toViemChain(network);
  const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) }) as PublicClient;
  const walletClient = createWalletClient({ account: wallet.account, chain, transport: http(network.rpcUrl) });
  return { client: createSquareClient({ publicClient, walletClient, deployment }), address: wallet.address as Address };
}
