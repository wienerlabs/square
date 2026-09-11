import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, networks } from "@squaresdk/core";
import { createHealth, createLogger, createMetrics } from "@squaresdk/observability";
import { screenerApp } from "./app.js";
import { screenerChecks } from "./checks.js";
import { screenAndSign } from "./screen.js";
import { TRM_DEFAULT_BASE_URL, TrmSanctionsSource } from "./source.js";
import { submitScreenings } from "./submit.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is not an address`);
  return getAddress(value);
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function main(): Promise<void> {
  const chainId = integer("CHAIN_ID", ARC_TESTNET_CHAIN_ID);
  const rpcUrl = required("RPC_URL");
  const registry = address("SCREENING_REGISTRY");
  // No default: which address proves the source is live is a choice the
  // operator makes and can defend, not one buried in the code.
  const canary = address("SCREENING_CANARY");
  const account = privateKeyToAccount(required("SCREENER_PRIVATE_KEY") as Hex);
  const version = process.env["SQUARE_VERSION"] ?? "0.1.0";
  const submitGas = BigInt(integer("SUBMIT_GAS", 400_000));
  const profile = networks[chainId];
  const chain = defineChain({
    id: chainId,
    name: profile?.name ?? `chain-${chainId}`,
    nativeCurrency: profile?.nativeCurrency ?? { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  // How often a submission's receipt is polled for. viem's default, for a chain
  // that declares no block time, is 4 seconds, and on Arc, which confirms in about
  // half a second, that polling interval was most of the latency a release-time
  // screening added (docs/decisions/sanctions-screening.md, "Latency").
  const pollingInterval = integer("RECEIPT_POLL_MS", 250);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account, pollingInterval });
  const source = new TrmSanctionsSource(process.env["TRM_BASE_URL"] ?? TRM_DEFAULT_BASE_URL);
  const logger = createLogger({ service: "square-screener", version, allowlist: ["registry", "canary", "screener", "sourceMs", "submitMs"] });
  const metrics = createMetrics({ service: "square-screener" });
  const health = createHealth({
    service: "square-screener",
    version,
    checks: screenerChecks({ publicClient, chainId, account: account.address, registry, submitGas, minSubmitsFunded: integer("MIN_SUBMITS_FUNDED", 3) }),
  });

  const app = screenerApp({
    logger,
    health,
    metrics,
    service: {
      async screen(subjects) {
        const { screenings, sourceMs } = await screenAndSign(
          { source, canary, signer: account, domain: { chainId, registry }, chainTime: async () => (await publicClient.getBlock()).timestamp },
          subjects,
        );
        const submitted = performance.now();
        const transactionHash = await submitScreenings(walletClient, publicClient, registry, screenings);
        const submitMs = Math.round(performance.now() - submitted);
        logger.info("screener.recorded", { count: screenings.length, txHash: transactionHash, sourceMs, submitMs });
        return { screenings, transactionHash, timings: { sourceMs, submitMs } };
      },
    },
  });
  serve({ fetch: app.fetch, port: integer("PORT", 3012) }, (info) => {
    logger.info("screener.listening", { endpoint: `http://localhost:${info.port}`, registry, canary, screener: account.address });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
