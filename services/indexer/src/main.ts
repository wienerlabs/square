import { serve } from "@hono/node-server";
import { createPublicClient, http } from "viem";
import { migrate, MIGRATIONS_DIR, pgDatabase, pgliteDatabase } from "@squaresdk/data";
import { createHealth, createLogger, createMetrics } from "@squaresdk/observability";
import { createApi } from "./api.js";
import { configFromEnv } from "./config.js";
import { Indexer } from "./sync.js";

async function main(): Promise<void> {
  const config = configFromEnv();
  const logger = createLogger({ service: "square-indexer", version: config.version });
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
  });
  await indexer.start();

  const health = createHealth({
    service: "square-indexer",
    version: config.version,
    checks: {
      database: { check: async () => ({ ok: (await db.query("select 1")).rowCount === 1 }), critical: true },
      rpc: { check: async () => ({ ok: (await publicClient.getChainId()) === config.chainId }), critical: true },
      lag: () => {
        const lag = indexer.chainHead - (indexer.lastIndexedBlock ?? 0n);
        return { ok: lag < 100n, detail: `${lag} blocks behind` };
      },
    },
  });

  const app = createApi({ db, chainId: config.chainId, indexer, health, metrics });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("indexer.listening", { endpoint: `http://localhost:${info.port}` });
  });

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
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
