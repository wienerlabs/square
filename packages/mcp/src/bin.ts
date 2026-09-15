#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ARC_TESTNET_CHAIN_ID,
  createScreenerClient,
  createSquareClient,
  deploymentFor,
  deploymentFromJson,
  networkFor,
  type SquareDeployment,
  type SquareWalletClient,
} from "@squaresdk/core";
import { AipDidResolver } from "@squaresdk/did-resolver";
import { describeDutyEvent, parsePolicy } from "@squaresdk/policy";
import { createLocalProver, fileDutyState, type LocalProver } from "@squaresdk/policy/node";
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSquareMcpServer, type ComplianceOptions } from "./server.js";

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
 *   SQUARE_POLICY_FILE       the institution's policy (packages/policy README); with SQUARE_PROVER_ARTIFACTS, every hire's
 *                            release is proved and the proof kept bound to the job until it is released (square#335)
 *   SQUARE_PROVER_ARTIFACTS  the directory holding payment.wasm, payment.zkey and payment_vk.json; proofs are made in
 *                            this process, so the policy never leaves it (square#347)
 *   SQUARE_COMPLIANCE_INTERVAL_MS  how often the bound proofs are checked; 15000 by default, well inside the module's tolerance
 *   SQUARE_DUTY_STATE        where the jobs the duty watches are kept across restarts; <SQUARE_POLICY_FILE>.duty.json by
 *                            default, "off" to keep none (the chain is still scanned for this wallet's open jobs at start)
 *   SQUARE_SCREENER_URL      the screener service (services/screener) asked to screen a party the hook would refuse,
 *                            before a hire is funded and before a release (square#368, #369). On a hook that screens,
 *                            without it a hire whose party has no fresh record stops before funding, naming the party
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
  const screenerUrl = env("SQUARE_SCREENER_URL");
  const client = createSquareClient({
    publicClient,
    deployment,
    ...(walletClient ? { walletClient } : {}),
    ...(screenerUrl !== undefined ? { screener: createScreenerClient({ url: screenerUrl }) } : {}),
  });
  await client.assertChain();

  const resolver = new AipDidResolver({
    rpc: { [chainId]: rpcUrl },
    allowedRegistries: [deployment.identityRegistry],
    onNetworkError: (context, cause) => console.error(`[square-mcp] ${context}:`, cause),
  });

  const maxPayment = env("SQUARE_X402_MAX_PAYMENT") ?? "1.00";
  const jobDays = env("SQUARE_JOB_DAYS");
  const compliance = complianceOf();
  const server = createSquareMcpServer({
    client,
    resolver,
    callerDid: env("SQUARE_CALLER_DID"),
    ...(account !== undefined && maxPayment.toLowerCase() !== "off" && maxPayment !== "0"
      ? { x402: { account, maxAmountPerPayment: maxPayment } }
      : {}),
    ...(jobDays !== undefined ? { jobDays: Number(jobDays) } : {}),
    ...(compliance ? { compliance } : {}),
  });
  if (compliance) {
    // snarkjs keeps its worker threads between proofs, and they would keep the
    // process alive after the client has gone.
    const previousClose = server.server.onclose;
    server.server.onclose = () => {
      previousClose?.();
      void compliance.prover.close();
    };
  }

  await server.connect(new StdioServerTransport());
  console.error(
    `[square-mcp] serving Square on chain ${chainId} via ${rpcUrl}` +
      (account ? `, paying from ${account.address}` : ", read-only (no SQUARE_PRIVATE_KEY)") +
      (compliance ? `, proving releases under policy ${compliance.policy.policy_id} in this process, from ${compliance.prover.artifacts}` : "") +
      (screenerUrl !== undefined ? `, screening parties at ${screenerUrl}` : ""),
  );
}

/** Both of SQUARE_POLICY_FILE and SQUARE_PROVER_ARTIFACTS, or neither: one without the other is a misconfiguration, not a default. */
function complianceOf(): (ComplianceOptions & { prover: LocalProver }) | undefined {
  const file = env("SQUARE_POLICY_FILE");
  const artifacts = env("SQUARE_PROVER_ARTIFACTS");
  if (file === undefined && artifacts === undefined) return undefined;
  if (file === undefined || artifacts === undefined) {
    throw new Error("SQUARE_POLICY_FILE and SQUARE_PROVER_ARTIFACTS go together: the policy is what is proved, the circuit's files are what it is proved with");
  }
  const policy = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
  const interval = env("SQUARE_COMPLIANCE_INTERVAL_MS");
  const stateFile = env("SQUARE_DUTY_STATE") ?? `${file}.duty.json`;
  return {
    policy,
    // square#347: made here, so the policy's secret never crosses a process boundary.
    prover: createLocalProver({ artifacts }),
    ...(interval !== undefined ? { intervalMs: Number(interval) } : {}),
    ...(stateFile.toLowerCase() === "off" ? {} : { state: fileDutyState(stateFile) }),
    onEvent: (event) => console.error(`[square-mcp] compliance: ${describeDutyEvent(event)}`),
  };
}

main().catch((error: unknown) => {
  console.error(`[square-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
