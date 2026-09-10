import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, createSquareClient, deploymentFor, deploymentFromJson, networks } from "@squaresdk/core";
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
  const chainId = integer("CHAIN_ID", ARC_TESTNET_CHAIN_ID);
  const rpcUrl = required("RPC_URL");
  const version = process.env["SQUARE_VERSION"] ?? "0.1.0";
  const deploymentFile = process.env["SQUARE_DEPLOYMENT_FILE"];
  const deployment = deploymentFile ? deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8"))) : deploymentFor(chainId);
  const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex);
  // Known chains carry their own name and unit; an unknown chain id is still
  // allowed here, because SQUARE_DEPLOYMENT_FILE can point the keeper at one.
  const profile = networks[chainId];
  const chain = defineChain({
    id: chainId,
    name: profile?.name ?? `chain-${chainId}`,
    nativeCurrency: profile?.nativeCurrency ?? { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const logger = createLogger({ service: "square-keeper", version });
  const metrics = createMetrics({ service: "square-keeper" });
  const databaseUrl = process.env["DATABASE_URL"];
  const ephemeralMirror = !databaseUrl;
  const db = databaseUrl ? pgDatabase(databaseUrl) : await pgliteDatabase();
  if (ephemeralMirror) {
    await migrate(db, MIGRATIONS_DIR, "up");
    logger.warn("keeper.ephemeral_mirror", {
      reason: "DATABASE_URL is not set, so the job mirror lives in this process, no indexer writes to it and no job will ever be finalized",
    });
  }

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
    ephemeralMirror,
    retryPolicy: {
      baseDelaySeconds: BigInt(integer("RETRY_BASE_SECONDS", 60)),
      maxDelaySeconds: BigInt(integer("RETRY_MAX_SECONDS", 3_600)),
      giveUpAfter: integer("RETRY_GIVE_UP_AFTER", 6),
      maxJournalRowsPerJob: integer("RETRY_MAX_JOURNAL_ROWS", 3),
    },
  });

  const alerting = createAlerting({
    service: "square-keeper",
    rules: [
      keeperStalled({
        maxPendingAgeSeconds: integer("MAX_PENDING_AGE_SECONDS", 600),
        maxTickAgeSeconds: integer("MAX_TICK_AGE_SECONDS", 300),
      }),
    ],
    notify: process.env["ALERT_WEBHOOK_URL"] ? webhookNotifier(process.env["ALERT_WEBHOOK_URL"]) : logNotifier(logger),
  });
  const health = createHealth({
    service: "square-keeper",
    version,
    checks: {
      database: { check: async () => ({ ok: (await db.query("select 1")).rowCount === 1 }), critical: true },
      rpc: { check: async () => ({ ok: (await publicClient.getChainId()) === chainId }), critical: true },
      balance: {
        check: async () => {
          const balance = await publicClient.getBalance({ address: account.address });
          return { ok: balance > 10n ** 16n, detail: `${balance} wei of native USDC for gas` };
        },
        critical: true,
      },
      mirror: () => ({
        ok: !ephemeralMirror,
        detail: ephemeralMirror
          ? "DATABASE_URL is not set, the mirror is private to this process and stays empty"
          : "reading the mirror an indexer writes",
      }),
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
  const evaluateAlerts = async (): Promise<void> => {
    const result = await alerting.evaluate({ ...metrics.snapshot() });
    for (const failure of result.errors) {
      metrics.recordAlertDispatchFailure(failure.rule, failure.stage);
      logger.error("keeper.alert_dispatch_failed", { reason: `${failure.rule} failed at the ${failure.stage} stage: ${failure.error}` });
    }
  };
  const alertTimer = setInterval(() => {
    void evaluateAlerts().catch((error: unknown) => {
      logger.error("keeper.alert_cycle_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, integer("ALERT_INTERVAL_MS", 30_000));
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
