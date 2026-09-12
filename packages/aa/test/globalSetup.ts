import { readFileSync } from "node:fs";
import type { GlobalSetupContext } from "vitest/node";
import { arcDeploymentFile, deploySquareStack, startAnvilFork, type SquareDeployment } from "../scripts/fork.js";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
    deployment: SquareDeployment;
    /** `contracts/deployments/5042002.json` as it was before the stack was deployed. */
    arcDeploymentRecord: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => void> {
  // Read before anything runs, so a test can tell whether deploying the fork's
  // stack touched the committed record (#270).
  const arcDeploymentRecord = readFileSync(arcDeploymentFile, "utf8");
  const fork = await startAnvilFork();
  try {
    const deployment = await deploySquareStack(fork.rpcUrl);
    provide("rpcUrl", fork.rpcUrl);
    provide("deployment", deployment);
    provide("arcDeploymentRecord", arcDeploymentRecord);
  } catch (error) {
    fork.stop();
    throw error;
  }
  return () => fork.stop();
}
