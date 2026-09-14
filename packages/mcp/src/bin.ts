#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ARC_TESTNET_CHAIN_ID,
  createSquareClient,
  deploymentFor,
  deploymentFromJson,
  networkFor,
  type SquareDeployment,
  type SquareWalletClient,
} from "@squaresdk/core";
import { AipDidResolver } from "@squaresdk/did-resolver";
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSquareMcpServer } from "./server.js";

/**
 * `square-mcp`: the Square MCP server on stdio, the transport Claude Desktop
 * and Cursor launch a local server over.
 *
 * Configured by environment, because that is what a `claude_desktop_config.json`
 * entry can carry:
 *
 *   SQUARE_CHAIN_ID          5042002 (Arc Testnet) by default; 31337 for anvil
 *   SQUARE_RPC_URL           the chain's endpoint; defaults to the network profile's
 *   SQUARE_DEPLOYMENT_FILE   a contracts/deployments/<chainId>.json, for a local stack
 *   SQUARE_PRIVATE_KEY       the paying wallet. Without it the server only reads.
 *   SQUARE_CALLER_DID        the DID tasks are created under; default the wallet's did:pkh
 *   SQUARE_X402_MAX_PAYMENT  cap per x402 call, decimal USDC; "1.00" by default, "off" to not offer square_call
 *   SQUARE_JOB_DAYS          how long a hired job stays open; 7 by default
 *
 * A key in an environment variable is a key in the process table, the same
 * trade the CLI's unattended mode makes; it is the one a desktop client
 * offers. stdout is the protocol; everything said here goes to stderr.
 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  let name = `chain ${chainId}`;
  let nativeCurrency = { name: "Ether", symbol: "ETH", decimals: 18 };
  try {
    const profile = networkFor(chainId);
    name = profile.name;
    nativeCurrency = profile.nativeCurrency;
  } catch {
    /* a chain without a profile: the caller gave the endpoint, and the deployment file gives the addresses */
  }
  return defineChain({ id: chainId, name, nativeCurrency, rpcUrls: { default: { http: [rpcUrl] } } });
}

function deploymentOf(chainId: number): SquareDeployment {
  const file = env("SQUARE_DEPLOYMENT_FILE");
  if (file === undefined) return deploymentFor(chainId);
  const deployment = deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  if (deployment.chainId !== chainId) {
    throw new Error(`SQUARE_DEPLOYMENT_FILE ${file} is for chain ${deployment.chainId}, SQUARE_CHAIN_ID is ${chainId}`);
  }
  return deployment;
}

async function main(): Promise<void> {
  const chainId = Number(env("SQUARE_CHAIN_ID") ?? ARC_TESTNET_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`SQUARE_CHAIN_ID must be a positive integer, got ${env("SQUARE_CHAIN_ID")}`);
  const deployment = deploymentOf(chainId);
  let rpcUrl = env("SQUARE_RPC_URL");
  if (rpcUrl === undefined) {
    try {
      rpcUrl = networkFor(chainId).rpcUrl;
    } catch {
      throw new Error(`no RPC endpoint is known for chain ${chainId}; set SQUARE_RPC_URL`);
    }
  }
  const chain = chainFor(chainId, rpcUrl);
  // A hire is four transactions in a row, each awaited to its receipt; viem
  // polls a chain it does not know every four seconds, which is most of a
  // hire's wall clock on a chain that mines in one.
  const pollingInterval = 1_000;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval }) as PublicClient;

  const key = env("SQUARE_PRIVATE_KEY");
  const account = key === undefined ? undefined : privateKeyToAccount(key as `0x${string}`);
  const walletClient: SquareWalletClient | undefined =
    account === undefined ? undefined : createWalletClient({ account, chain, transport: http(rpcUrl), pollingInterval });
  const client = createSquareClient({ publicClient, deployment, ...(walletClient ? { walletClient } : {}) });
  await client.assertChain();

  const resolver = new AipDidResolver({
    rpc: { [chainId]: rpcUrl },
    allowedRegistries: [deployment.identityRegistry],
    onNetworkError: (context, cause) => console.error(`[square-mcp] ${context}:`, cause),
  });

  const maxPayment = env("SQUARE_X402_MAX_PAYMENT") ?? "1.00";
  const jobDays = env("SQUARE_JOB_DAYS");
  const server = createSquareMcpServer({
    client,
    resolver,
    callerDid: env("SQUARE_CALLER_DID"),
    ...(account !== undefined && maxPayment.toLowerCase() !== "off" && maxPayment !== "0"
      ? { x402: { account, maxAmountPerPayment: maxPayment } }
      : {}),
    ...(jobDays !== undefined ? { jobDays: Number(jobDays) } : {}),
  });

  await server.connect(new StdioServerTransport());
  console.error(
    `[square-mcp] serving Square on chain ${chainId} via ${rpcUrl}` +
      (account ? `, paying from ${account.address}` : ", read-only (no SQUARE_PRIVATE_KEY)"),
  );
}

main().catch((error: unknown) => {
  console.error(`[square-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
