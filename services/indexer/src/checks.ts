import type { PublicClient } from "viem";
import type { Database } from "@squaresdk/data";
import type { CheckResult, HealthCheck } from "@squaresdk/observability";

export interface SyncProgress {
  readonly lastIndexedBlock: bigint | null;
  readonly sampledChainHead: bigint | null;
  readonly lastSyncAt: number | null;
  readonly quarantinedEvents: readonly unknown[];
}

export interface ChecksOptions {
  db: Pick<Database, "query">;
  publicClient: Pick<PublicClient, "getChainId">;
  chainId: number;
  indexer: SyncProgress;
  maxLagBlocks: bigint;
  maxSyncAgeMs: number;
  startupGraceMs: number;
  now?: () => number;
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function unsampledSide(chainHead: bigint | null, indexedHead: bigint | null): string {
  if (chainHead === null && indexedHead === null) return "neither head has been sampled";
  if (chainHead === null) return "the chain head has not been sampled";
  return "no block has been indexed";
}

export function indexerChecks(options: ChecksOptions): Record<string, HealthCheck> {
  const clock = options.now ?? Date.now;
  const startedAt = clock();

  const lag = (): CheckResult => {
    const { lastIndexedBlock, sampledChainHead, lastSyncAt } = options.indexer;
    const at = clock();
    if (lastSyncAt !== null && at - lastSyncAt > options.maxSyncAgeMs) {
      return { ok: false, detail: `the last sync finished ${seconds(at - lastSyncAt)}s ago, limit ${seconds(options.maxSyncAgeMs)}s` };
    }
    if (sampledChainHead === null || lastIndexedBlock === null) {
      const waited = at - startedAt;
      const side = unsampledSide(sampledChainHead, lastIndexedBlock);
      return {
        ok: waited <= options.startupGraceMs,
        detail: `not measured yet, ${side}, ${seconds(waited)}s since start, grace ${seconds(options.startupGraceMs)}s`,
      };
    }
    const behind = sampledChainHead - lastIndexedBlock;
    if (behind < 0n) return { ok: false, detail: `the indexed head is ${-behind} blocks ahead of the chain head` };
    return { ok: behind <= options.maxLagBlocks, detail: `${behind} blocks behind, limit ${options.maxLagBlocks}` };
  };

  return {
    database: { check: async () => ({ ok: (await options.db.query("select 1")).rowCount === 1 }), critical: true },
    rpc: { check: async () => ({ ok: (await options.publicClient.getChainId()) === options.chainId }), critical: true },
    lag: { check: lag, critical: true },
    quarantine: () => {
      const count = options.indexer.quarantinedEvents.length;
      return { ok: count === 0, detail: count === 0 ? "no event set aside" : `${count} events set aside, see /quarantine` };
    },
  };
}
