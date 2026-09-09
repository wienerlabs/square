import { readFileSync } from "node:fs";
import { ARC_TESTNET_CHAIN_ID, deploymentFor, deploymentFromJson, type SquareDeployment } from "@squaresdk/core";

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

export function loadDeployment(chainId: number): SquareDeployment {
  const file = process.env["SQUARE_DEPLOYMENT_FILE"];
  if (file) return deploymentFromJson(JSON.parse(readFileSync(file, "utf8")));
  return deploymentFor(chainId);
}

export function configFromEnv(): IndexerConfig {
  const chainId = integer("CHAIN_ID", ARC_TESTNET_CHAIN_ID);
  return {
    chainId,
    rpcUrl: required("RPC_URL"),
    deployment: loadDeployment(chainId),
    startBlock: BigInt(integer("START_BLOCK", 0)),
    batchBlocks: BigInt(integer("BATCH_BLOCKS", 2000)),
    pollIntervalMs: integer("POLL_INTERVAL_MS", 3000),
    port: integer("PORT", 3010),
    databaseUrl: process.env["DATABASE_URL"],
    version: process.env["SQUARE_VERSION"] ?? "0.1.0",
  };
}
