import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, createSquareClient, deploymentFor, deploymentFromJson, networks } from "@squaresdk/core";
import { keeperActions, keeperJobState, migrate, MIGRATIONS_DIR, pgDatabase, pgliteDatabase } from "@squaresdk/data";
import {
  createAlerting,
  createHealth,
  createLogger,
  createMetrics,
  finalizeGasUnderestimated,
  keeperStalled,
  logNotifier,
  releaseRefused,
  webhookNotifier,
} from "@squaresdk/observability";
import { observabilityRoutes } from "@squaresdk/observability/hono";
import { keeperChecks } from "./checks.js";
import { describeGate, finalizeGasDefaults, readComplianceGate } from "./gas.js";
import { HOLD_REASONS, Keeper, KEEPER_LOG_FIELDS } from "./run.js";
import { assertScreenerForHook, assertScreenerUrl, DEFAULT_SCREENER_TIMEOUT_MS, payeeScreening } from "./screening.js";

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

function optionalInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return integer(name, 0);
}

async function main(): Promise<void> {
  const chainId = integer("CHAIN_ID", ARC_TESTNET_CHAIN_ID);
  const rpcUrl = required("RPC_URL");
  const version = process.env["SQUARE_VERSION"] ?? "0.1.0";
  const deploymentFile = process.env["SQUARE_DEPLOYMENT_FILE"];
  const deployment = deploymentFile ? deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8"))) : deploymentFor(chainId);
  const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex);
  const operatorFinalizeGas = optionalInteger("FINALIZE_GAS");
  const operatorFinalizeDecidedGas = optionalInteger("FINALIZE_DECIDED_GAS");
  // Known chains carry their own name and unit; an unknown chain id is still
  // allowed here, because SQUARE_DEPLOYMENT_FILE can point the keeper at one.
  const profile = networks[chainId];
  const chain = defineChain({
    id: chainId,
    name: profile?.name ?? `chain-${chainId}`,
    nativeCurrency: profile?.nativeCurrency ?? { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const logger = createLogger({ service: "square-keeper", version, allowlist: KEEPER_LOG_FIELDS });
  const metrics = createMetrics({ service: "square-keeper" });
  const databaseUrl = process.env["DATABASE_URL"];
  const ephemeralMirror = !databaseUrl;
  const db = databaseUrl
    ? pgDatabase(databaseUrl, { onPoolError: (error) => logger.error("keeper.pool_error", { error: error.message }) })
    : await pgliteDatabase();
  if (ephemeralMirror) {
    await migrate(db, MIGRATIONS_DIR, "up");
    logger.warn("keeper.ephemeral_mirror", {
      reason: "DATABASE_URL is not set, so the job mirror lives in this process, no indexer writes to it and no job will ever be finalized",
    });
  }

  // square#35. The screener URL is checked at boot, and again on every request:
  // it may resolve to a private or loopback address only when
  // SCREENER_ALLOW_PRIVATE says so, and never to a link-local one.
  const screenerUrl = process.env["SCREENER_URL"];
  const screenerTimeoutMs = integer("SCREENER_TIMEOUT_MS", DEFAULT_SCREENER_TIMEOUT_MS);
  if (screenerTimeoutMs === 0) throw new Error("SCREENER_TIMEOUT_MS must be positive");
  const screener = screenerUrl
    ? { url: screenerUrl, allowPrivate: process.env["SCREENER_ALLOW_PRIVATE"] === "true", timeoutMs: screenerTimeoutMs }
    : undefined;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  let screeningUnknown = false;
  if (screener) await assertScreenerUrl(`${screener.url}/screen`, screener.allowPrivate);
  else {
    const unreadable = await assertScreenerForHook(publicClient, deployment.squareHook);
    screeningUnknown = unreadable !== undefined;
    if (unreadable) {
      logger.warn("keeper.screening_unknown", {
        reason:
          `${deployment.squareHook} could not be read at boot (${unreadable.message}), so whether it screens is unknown; ` +
          "with no SCREENER_URL every payee the registry does not already clear is held rather than finalized",
      });
    }
  }

  const client = createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain, transport: http(rpcUrl), account }) });

  const gate = await readComplianceGate(client, logger);
  const complianceModule = gate.module;
  const tolerance = gate.tolerance;
  const defaults = finalizeGasDefaults(gate.gated);
  const finalizeGas = operatorFinalizeGas === undefined ? defaults.finalizeGas : BigInt(operatorFinalizeGas);
  const finalizeDecidedGas = operatorFinalizeDecidedGas === undefined ? defaults.finalizeDecidedGas : BigInt(operatorFinalizeDecidedGas);
  const pinnedFinalizeGas = operatorFinalizeGas !== undefined || operatorFinalizeDecidedGas !== undefined;
  const proofGraceSeconds = BigInt(optionalInteger("PROOF_GRACE_SECONDS") ?? Number(tolerance ?? 3_600n));
  logger.info("keeper.gas_assumption", {
    reason:
      `${describeGate(gate)}, ` +
      `so finalize assumes ${finalizeGas} gas and finalizeDecided ${finalizeDecidedGas}` +
      `${pinnedFinalizeGas ? ", pinned by the operator, so no receipt moves it" : ", until the first receipts move it"}`,
  });

  const keeper = new Keeper({
    db,
    chainId,
    client,
    logger,
    metrics,
    minimumMarginBps: integer("MINIMUM_MARGIN_BPS", 2000),
    defaultFinalizeGas: finalizeGas,
    defaultFinalizeDecidedGas: finalizeDecidedGas,
    pinnedFinalizeGas,
    finalizeGasSamples: integer("FINALIZE_GAS_SAMPLES", 5),
    complianceModule,
    gated: gate.gated,
    proofGraceSeconds,
    recordExpiries: process.env["RECORD_EXPIRIES"] !== "false",
    expiryBatchSize: integer("EXPIRY_BATCH_SIZE", 25),
    expiryIntervalMs: integer("EXPIRY_INTERVAL_MS", 60_000),
    ephemeralMirror,
    // square#35: with a screener to ask, a release on a hook that screens is
    // finalized only once its payee is freshly screened.
    ...(screener || screeningUnknown
      ? { screenPayees: payeeScreening({ client, publicClient, ...(screener ? { screener } : {}) }) }
      : {}),
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
      finalizeGasUnderestimated({ maxOvershootRatio: integer("MAX_GAS_OVERSHOOT_PERCENT", 25) / 100 }),
      releaseRefused(),
    ],
    notify: process.env["ALERT_WEBHOOK_URL"] ? webhookNotifier(process.env["ALERT_WEBHOOK_URL"]) : logNotifier(logger),
  });
  const health = createHealth({
    service: "square-keeper",
    version,
    checks: keeperChecks({
      db,
      publicClient,
      chainId,
      account: account.address,
      hook: deployment.squareHook,
      finalizeGas: () => keeper.gasAssumed("finalize"),
      minActionsFunded: integer("MIN_ACTIONS_FUNDED", 3),
      ephemeralMirror,
      ...(screener ? { screener } : {}),
    }),
  });

  const app = new Hono();
  app.route("/", observabilityRoutes({ health, metrics }));
  app.get("/actions", async (c) =>
    c.json((await keeperActions.recent(db, chainId, 50)).map((a) => ({ ...a, id: a.id.toString(), jobId: a.jobId.toString(), gasUsed: a.gasUsed?.toString() ?? null, feeEarned: a.feeEarned?.toString() ?? null }))),
  );
  app.get("/status", async (c) => {
    const counts = await keeperJobState.countHeld(db, chainId);
    return c.json({
      chainId,
      keeper: account.address,
      complianceModule,
      finalizeGas: {
        finalize: keeper.gasAssumed("finalize").toString(),
        finalizeDecided: keeper.gasAssumed("finalizeDecided").toString(),
        source: keeper.gasSource("finalize"),
      },
      held: {
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
        byReason: Object.fromEntries(HOLD_REASONS.map((reason) => [reason, counts[reason] ?? 0])),
        graceSeconds: { proofStale: Number(proofGraceSeconds) },
        jobs: (await keeperJobState.listHeld(db, chainId)).map((row) => ({ jobId: row.jobId.toString(), reason: row.reason, since: row.since.toString() })),
      },
    });
  });
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
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await keeper.run(integer("POLL_INTERVAL_MS", 15_000), controller.signal);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ event: "keeper.fatal", error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exit(1);
});
