import { serve } from "@hono/node-server";
import { createPublicClient, http } from "viem";
import { migrate, MIGRATIONS_DIR, pgDatabase, pgliteDatabase } from "@squaresdk/data";
import {
  createAlerting,
  createHealth,
  createLogger,
  createMetrics,
  hookWriteFailures,
  indexerLagging,
  logNotifier,
  webhookNotifier,
} from "@squaresdk/observability";
import { createApi } from "./api.js";
import { indexerChecks } from "./checks.js";
import { configFromEnv } from "./config.js";
import { Indexer } from "./sync.js";

async function main(): Promise<void> {
  const config = configFromEnv();
  const logger = createLogger({ service: "square-indexer", version: config.version, allowlist: ["applied"] });
  const metrics = createMetrics({ service: "square-indexer" });
  const db = config.databaseUrl ? pgDatabase(config.databaseUrl) : await pgliteDatabase();
  if (!config.databaseUrl) {
    await migrate(db, MIGRATIONS_DIR, "up");
    logger.warn("indexer.ephemeral_database", { reason: "DATABASE_URL is not set, state lives in memory" });
  }
  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const indexer = new Indexer({
    db,
    publicClient,
    chainId: config.chainId,
    deployment: config.deployment,
    startBlock: config.startBlock,
    batchBlocks: config.batchBlocks,
    logger,
    metrics,
    onDeploymentChange: config.onDeploymentChange,
  });
  await indexer.start();

  const health = createHealth({
    service: "square-indexer",
    version: config.version,
    checks: indexerChecks({
      db,
      publicClient,
      chainId: config.chainId,
      indexer,
      maxLagBlocks: config.maxLagBlocks,
      maxSyncAgeMs: config.maxSyncAgeMs,
      startupGraceMs: config.startupGraceMs,
    }),
  });

  const alerting = createAlerting({
    service: "square-indexer",
    rules: [indexerLagging({ maxLagBlocks: Number(config.maxLagBlocks) }), hookWriteFailures()],
    notify: config.alertWebhookUrl ? webhookNotifier(config.alertWebhookUrl) : logNotifier(logger),
  });
  const evaluateAlerts = async (): Promise<void> => {
    const result = await alerting.evaluate({ ...metrics.snapshot() });
    for (const failure of result.errors) {
      metrics.recordAlertDispatchFailure(failure.rule, failure.stage);
      logger.error("indexer.alert_dispatch_failed", { reason: `${failure.rule} failed at the ${failure.stage} stage: ${failure.error}` });
    }
  };
  const alertTimer = setInterval(() => {
    void evaluateAlerts().catch((error: unknown) => {
      logger.error("indexer.alert_cycle_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, config.alertIntervalMs);

  const app = createApi({ db, chainId: config.chainId, indexer, health, metrics, corsOrigins: config.corsOrigins });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("indexer.listening", { endpoint: `http://localhost:${info.port}` });
  });

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
    clearInterval(alertTimer);
    server.close();
    void db.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await indexer.run(config.pollIntervalMs, controller.signal);
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ event: "indexer.fatal", error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exit(1);
});
