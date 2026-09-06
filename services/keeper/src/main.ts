import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSquareClient, deploymentFor, deploymentFromJson } from "@squaresdk/core";
import { keeperActions, migrate, MIGRATIONS_DIR, pgDatabase, pgliteDatabase } from "@squaresdk/data";
import { createAlerting, createHealth, createLogger, createMetrics, keeperStalled, logNotifier, webhookNotifier } from "@squaresdk/observability";
import { observabilityRoutes } from "@squaresdk/observability/hono";
import { Keeper } from "./run.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function main(): Promise<void> {
  const chainId = integer("CHAIN_ID", 5042002);
  const rpcUrl = required("RPC_URL");
  const version = process.env["SQUARE_VERSION"] ?? "0.1.0";
  const deploymentFile = process.env["SQUARE_DEPLOYMENT_FILE"];
  const deployment = deploymentFile ? deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8"))) : deploymentFor(chainId);
  const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const logger = createLogger({ service: "square-keeper", version });
  const metrics = createMetrics({ service: "square-keeper" });
  const databaseUrl = process.env["DATABASE_URL"];
  const db = databaseUrl ? pgDatabase(databaseUrl) : await pgliteDatabase();
  if (!databaseUrl) await migrate(db, MIGRATIONS_DIR, "up");

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const client = createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain, transport: http(rpcUrl), account }) });
  const keeper = new Keeper({
    db,
    chainId,
    client,
    logger,
    metrics,
    minimumMarginBps: integer("MINIMUM_MARGIN_BPS", 2000),
    defaultFinalizeGas: BigInt(integer("FINALIZE_GAS", 450_000)),
    defaultFinalizeDecidedGas: BigInt(integer("FINALIZE_DECIDED_GAS", 500_000)),
    recordExpiries: process.env["RECORD_EXPIRIES"] !== "false",
  });

  const alerting = createAlerting({
    service: "square-keeper",
    rules: [keeperStalled({ maxPendingAgeSeconds: integer("MAX_PENDING_AGE_SECONDS", 600) })],
    notify: process.env["ALERT_WEBHOOK_URL"] ? webhookNotifier(process.env["ALERT_WEBHOOK_URL"]) : logNotifier(logger),
  });
  const health = createHealth({
    service: "square-keeper",
    version,
    checks: {
      database: { check: async () => ({ ok: (await db.query("select 1")).rowCount === 1 }), critical: true },
      rpc: { check: async () => ({ ok: (await publicClient.getChainId()) === chainId }), critical: true },
      balance: async () => {
        const balance = await publicClient.getBalance({ address: account.address });
        return { ok: balance > 10n ** 16n, detail: `${balance} wei of native USDC for gas` };
      },
    },
  });

  const app = new Hono();
  app.route("/", observabilityRoutes({ health, metrics }));
  app.get("/actions", async (c) =>
    c.json((await keeperActions.recent(db, chainId, 50)).map((a) => ({ ...a, id: a.id.toString(), jobId: a.jobId.toString(), gasUsed: a.gasUsed?.toString() ?? null, feeEarned: a.feeEarned?.toString() ?? null }))),
  );
  const server = serve({ fetch: app.fetch, port: integer("PORT", 3011) }, (info) => {
    logger.info("keeper.listening", { endpoint: `http://localhost:${info.port}`, keeper: account.address });
  });

  const controller = new AbortController();
  const alertTimer = setInterval(() => {
    void alerting.evaluate({ ...metrics.snapshot() });
  }, 30_000);
  const stop = (): void => {
    controller.abort();
    clearInterval(alertTimer);
    server.close();
    void db.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await keeper.run(integer("POLL_INTERVAL_MS", 15_000), controller.signal);
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ event: "keeper.fatal", error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exit(1);
});
