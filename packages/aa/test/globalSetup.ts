import type { GlobalSetupContext } from "vitest/node";
import { deploySquareStack, startAnvilFork, type SquareDeployment } from "../scripts/fork.js";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
    deployment: SquareDeployment;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => void> {
  const fork = await startAnvilFork();
  try {
    const deployment = await deploySquareStack(fork.rpcUrl);
    provide("rpcUrl", fork.rpcUrl);
    provide("deployment", deployment);
  } catch (error) {
    fork.stop();
    throw error;
  }
  return () => fork.stop();
}
