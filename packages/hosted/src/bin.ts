#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ARC_TESTNET_CHAIN_ID,
  createScreenerClient,
  deploymentFor,
  deploymentFromJson,
  networkFor,
  type SquareDeployment,
} from "@squaresdk/core";
import { describeDutyEvent, parsePolicy } from "@squaresdk/policy";
import { createLocalProver, fileDutyState, type LocalProver } from "@squaresdk/policy/node";
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseHostedConfig, type HostedAgentConfig } from "./config.js";
import { hostAgent, sealContext, type ComplianceDeps } from "./host.js";
import { deriveSealKey, seal } from "./sealed.js";

/**
 * `square-hosted <config.json>`: run the agent the configuration describes.
 * `square-hosted` with no path: the same, from the configuration in
 * SQUARE_HOSTED_CONFIG, for a host that has variables and no files to mount
 * (docs/deploy/railway.md); the policy and state files of a compliance block
 * are then relative to the working directory.
 * `square-hosted seal <agentId>`: seal an institution's API key, read from
 * stdin, for that agent's configuration.
 *
 *   SQUARE_PRIVATE_KEY       the wallet that owns the config's agentId (required to run)
 *   SQUARE_HOSTED_CONFIG     the configuration itself, as JSON, when no path is given
 *   SQUARE_CHAIN_ID          5042002 (Arc Testnet) by default; 31337 for anvil
 *   SQUARE_RPC_URL           the chain's endpoint; defaults to the network profile's
 *   SQUARE_DEPLOYMENT_FILE   a contracts/deployments/<chainId>.json, for a local stack
 *   SQUARE_SEAL_SECRET       what own-tier keys are sealed under (seal, and run with an own key)
 *   ANTHROPIC_API_KEY        the platform tier's key, read by the Anthropic SDK itself
 *   PORT, HOST               where the agent listens; 3000 and 0.0.0.0
 *   SQUARE_PROVER_ARTIFACTS  the directory holding payment.wasm, payment.zkey and payment_vk.json (a config with a compliance block)
 *
 * A config with a `compliance` block names the policy file (relative to the
 * config); the host proves with the circuit's files in SQUARE_PROVER_ARTIFACTS,
 * in this process, so the policy never leaves it (square#347), keeps a proof
 * bound to every job it delegates and releases each when its window closes
 * (square#335).
 *
 * A key in an environment variable is a key in the process table, the same
 * trade the CLI's unattended mode makes; an institution's own key never sits
 * in one, only sealed in its configuration.
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
    /* a chain without a profile: the endpoint was given, the deployment file gives the addresses */
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function sealCommand(agentId: string | undefined): Promise<void> {
  if (agentId === undefined || !/^\d+$/.test(agentId)) throw new Error("usage: square-hosted seal <agentId>  (the key on stdin)");
  const secret = env("SQUARE_SEAL_SECRET");
  if (secret === undefined) throw new Error("set SQUARE_SEAL_SECRET to seal a key");
  const key = await readStdin();
  if (key === "") throw new Error("nothing on stdin to seal");
  process.stdout.write(seal(key, deriveSealKey(secret), sealContext({ agentId })) + "\n");
}

async function runCommand(path: string | undefined): Promise<void> {
  const inline = env("SQUARE_HOSTED_CONFIG");
  if (path === undefined && inline === undefined) {
    throw new Error("usage: square-hosted <config.json> | square-hosted seal <agentId>; or the configuration as JSON in SQUARE_HOSTED_CONFIG");
  }
  const config = parseHostedConfig(JSON.parse(path !== undefined ? readFileSync(path, "utf8") : (inline as string)));
  // Where a compliance block's policy and state files are: beside the
  // configuration file, or in the working directory for one from the environment.
  const files = path !== undefined ? { dir: dirname(path), stateDefault: `${path}.duty.json` } : { dir: process.cwd(), stateDefault: resolve(process.cwd(), "square-hosted.duty.json") };

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
  const key = env("SQUARE_PRIVATE_KEY");
  if (key === undefined) throw new Error("SQUARE_PRIVATE_KEY is the wallet that owns the agent; it is required");
  const chain = chainFor(chainId, rpcUrl);
  const account = privateKeyToAccount(key as `0x${string}`);
  const pollingInterval = 1_000;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl), pollingInterval });

  const compliance = complianceOf(config, files);
  const screenerUrl = config.delegation?.screenerUrl;
  const hosted = await hostAgent(config, {
    walletClient,
    publicClient,
    deployment,
    rpcUrl,
    sealSecret: env("SQUARE_SEAL_SECRET"),
    ...(screenerUrl !== undefined ? { screener: createScreenerClient({ url: screenerUrl }) } : {}),
    onRun: ({ taskId, capability, outcome }) =>
      console.error(`[square-hosted] ${capability} task ${taskId}: ${outcome.turns} turn(s), ${outcome.toolCalls.length} tool call(s), ${outcome.usage.inputTokens}/${outcome.usage.outputTokens} tokens`),
    ...(compliance ? { compliance } : {}),
  });
  await hosted.agent.client.assertChain();
  const port = Number(env("PORT") ?? 3000);
  const listening = await hosted.agent.listen(port, env("HOST") ?? "0.0.0.0");
  console.error(
    `[square-hosted] ${config.name} (${hosted.agent.did}) listening at ${listening.url}: ` +
      `${config.capabilities.map((c) => c.id).join(", ")}; ${config.provider.tier} key; ` +
      `${hosted.tools ? `${(await hosted.tools.tools()).length} MCP tool(s)` : "no MCP tools"}; ` +
      `${config.delegation ? `may hire ${config.delegation.allow.join(", ")}` : "no delegation"}` +
      `${compliance ? `; proving delegated releases under policy ${compliance.policy.policy_id} in this process, from ${compliance.prover.artifacts}` : ""}` +
      `${screenerUrl !== undefined ? `; screening delegated parties at ${screenerUrl}` : ""}`,
  );
  const stop = async () => {
    await listening.close();
    await hosted.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

/** The config's compliance block as the host's deps: the policy read from beside the config, the proof made in this process. */
function complianceOf(config: HostedAgentConfig, files: { dir: string; stateDefault: string }): (ComplianceDeps & { prover: LocalProver }) | undefined {
  if (!config.compliance) return undefined;
  const artifacts = env("SQUARE_PROVER_ARTIFACTS");
  if (artifacts === undefined) {
    throw new Error("a compliance block needs SQUARE_PROVER_ARTIFACTS, the directory holding payment.wasm, payment.zkey and payment_vk.json: the proof is made in this process, so the policy never leaves it");
  }
  const file = resolve(files.dir, config.compliance.policyFile);
  const policy = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
  const stateFile = config.compliance.stateFile === undefined ? files.stateDefault : config.compliance.stateFile === false ? undefined : resolve(files.dir, config.compliance.stateFile);
  return {
    policy,
    prover: createLocalProver({ artifacts }),
    intervalMs: config.compliance.intervalMs,
    ...(stateFile !== undefined ? { state: fileDutyState(stateFile) } : {}),
    onEvent: (event) => console.error(`[square-hosted] compliance: ${describeDutyEvent(event)}`),
  };
}

const [command, argument] = process.argv.slice(2);
(command === "seal" ? sealCommand(argument) : runCommand(command)).catch((error: unknown) => {
  console.error(`[square-hosted] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
