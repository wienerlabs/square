#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentFor,
  deploymentFromJson,
  networkFor,
  type SquareDeployment,
} from "@squaresdk/core";
import { createProverClient, parsePolicy } from "@squaresdk/policy";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseHostedConfig, type HostedAgentConfig } from "./config.js";
import { hostAgent, sealContext, type ComplianceDeps } from "./host.js";
import { deriveSealKey, seal } from "./sealed.js";

/**
 * `square-hosted <config.json>`: run the agent the configuration describes.
 * `square-hosted seal <agentId>`: seal an institution's API key, read from
 * stdin, for that agent's configuration.
 *
 *   SQUARE_PRIVATE_KEY       the wallet that owns the config's agentId (required to run)
 *   SQUARE_CHAIN_ID          5042002 (Arc Testnet) by default; 31337 for anvil
 *   SQUARE_RPC_URL           the chain's endpoint; defaults to the network profile's
 *   SQUARE_DEPLOYMENT_FILE   a contracts/deployments/<chainId>.json, for a local stack
 *   SQUARE_SEAL_SECRET       what own-tier keys are sealed under (seal, and run with an own key)
 *   ANTHROPIC_API_KEY        the platform tier's key, read by the Anthropic SDK itself
 *   PORT, HOST               where the agent listens; 3000 and 0.0.0.0
 *
 * A config with a `compliance` block names the policy file (relative to the
 * config) and the prover; the host then keeps a proof bound to every job it
 * delegates and releases each when its window closes (square#335).
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
  if (path === undefined) throw new Error("usage: square-hosted <config.json> | square-hosted seal <agentId>");
  const config = parseHostedConfig(JSON.parse(readFileSync(path, "utf8")));

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

  const compliance = complianceOf(config, path);
  const hosted = await hostAgent(config, {
    walletClient,
    publicClient,
    deployment,
    rpcUrl,
    sealSecret: env("SQUARE_SEAL_SECRET"),
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
      `${compliance ? `; proving delegated releases under policy ${compliance.policy.policy_id} at ${config.compliance!.proverUrl}` : ""}`,
  );
  const stop = async () => {
    await listening.close();
    await hosted.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

/** The config's compliance block as the host's deps: the policy read from beside the config, the prover as a client. */
function complianceOf(config: HostedAgentConfig, configPath: string): ComplianceDeps | undefined {
  if (!config.compliance) return undefined;
  const file = resolve(dirname(configPath), config.compliance.policyFile);
  const policy = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
  return {
    policy,
    prover: createProverClient({ url: config.compliance.proverUrl }),
    intervalMs: config.compliance.intervalMs,
    onEvent: (event) => {
      const text =
        event.type === "error"
          ? `${event.jobId === null ? "duty" : `job ${event.jobId}`}: ${event.error.message}`
          : event.type === "no-module"
            ? "the hook holds no compliance module; nothing to prove"
            : event.type === "bound"
              ? `job ${event.jobId}: proof bound in ${event.transaction} (${event.because.join("; ")})`
              : event.type === "refused"
                ? `job ${event.jobId}: no proof bound, ${event.reason}: ${event.detail}`
                : event.type === "released"
                  ? `job ${event.jobId}: released in ${event.transaction}, ${event.verified === false ? `refused by the module (${event.refusedFor ?? "reason unknown"})` : `${formatUnits(event.amount, 6)} USDC to ${event.payee}`}`
                  : `job ${event.jobId}: settled by another hand (status ${event.status})`;
      console.error(`[square-hosted] compliance: ${text}`);
    },
  };
}

const [command, argument] = process.argv.slice(2);
(command === "seal" ? sealCommand(argument) : runCommand(command)).catch((error: unknown) => {
  console.error(`[square-hosted] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
