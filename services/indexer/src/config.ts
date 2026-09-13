import { readFileSync } from "node:fs";
import { ARC_TESTNET_CHAIN_ID, deploymentFor, deploymentFromJson, type SquareDeployment } from "@squaresdk/core";
import type { DeploymentChangePolicy } from "./sync.js";

export interface IndexerConfig {
  chainId: number;
  rpcUrl: string;
  deployment: SquareDeployment;
  startBlock: bigint;
  batchBlocks: bigint;
  pollIntervalMs: number;
  port: number;
  databaseUrl: string | undefined;
  version: string;
  corsOrigins: string[];
  maxLagBlocks: bigint;
  maxSyncAgeMs: number;
  startupGraceMs: number;
  alertIntervalMs: number;
  alertWebhookUrl: string | undefined;
  onDeploymentChange: DeploymentChangePolicy;
}

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

function originList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadDeployment(chainId: number): SquareDeployment {
  const file = process.env["SQUARE_DEPLOYMENT_FILE"];
  if (file) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(chainId);
}

export function startBlockFor(deployment: SquareDeployment): bigint {
  const configured = process.env["START_BLOCK"];
  if (configured !== undefined && configured !== "") return BigInt(integer("START_BLOCK", 0));
  if (deployment.startBlock !== undefined) return deployment.startBlock;
  throw new Error(
    "START_BLOCK is unset and the deployment record carries no block. Scanning from genesis is not a default: set START_BLOCK to the block the stack was deployed in, or take it from a deployment record written by a script that records one.",
  );
}

function deploymentChangePolicy(): DeploymentChangePolicy {
  const raw = process.env["ON_DEPLOYMENT_CHANGE"];
  if (raw === undefined || raw === "") return "fail";
  if (raw === "fail" || raw === "restart") return raw;
  throw new Error("ON_DEPLOYMENT_CHANGE must be fail or restart");
}

export function configFromEnv(): IndexerConfig {
  const chainId = integer("CHAIN_ID", ARC_TESTNET_CHAIN_ID);
  const deployment = loadDeployment(chainId);
  return {
    chainId,
    rpcUrl: required("RPC_URL"),
    deployment,
    startBlock: startBlockFor(deployment),
    batchBlocks: BigInt(integer("BATCH_BLOCKS", 2000)),
    pollIntervalMs: integer("POLL_INTERVAL_MS", 3000),
    port: integer("PORT", 3010),
    databaseUrl: process.env["DATABASE_URL"],
    version: process.env["SQUARE_VERSION"] ?? "0.1.0",
    corsOrigins: originList("CORS_ORIGINS"),
    maxLagBlocks: BigInt(integer("MAX_LAG_BLOCKS", 100)),
    maxSyncAgeMs: integer("MAX_SYNC_AGE_MS", 120_000),
    startupGraceMs: integer("STARTUP_GRACE_MS", 60_000),
    alertIntervalMs: integer("ALERT_INTERVAL_MS", 30_000),
    alertWebhookUrl: process.env["ALERT_WEBHOOK_URL"],
    onDeploymentChange: deploymentChangePolicy(),
  };
}
