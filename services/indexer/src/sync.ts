import type { Address, Hex, Log, PublicClient } from "viem";
import { decodeSquareLogs, type SquareDeployment, type SquareEvent } from "@squaresdk/core";
import { arbiterSets, checkpoints, claimListings, disputes, jobEvents, jobs, ledgerBalances, type Database, type IndexedContract } from "@squaresdk/data";
import type { Logger, Metrics } from "@squaresdk/observability";
import { applyEvent, cloneState, emptyState, ledgerKey, type IndexerState, type ReducerNotice } from "./reducer.js";

const CONTRACTS: IndexedContract[] = ["SquareJob", "KeeperEvaluator", "Arbitration", "ClaimMarket", "SquareHook"];

export const DERIVED_TABLES = ["jobs", "disputes", "claim_listings", "ledger_balances", "arbiter_sets", "job_events"] as const;

interface JournalRow {
  block_number: string;
  log_index: number;
  tx_hash: Uint8Array;
  args: { raw: { address: Address; topics: Hex[]; data: Hex } };
}

interface Dirty {
  jobs: Set<bigint>;
  disputes: Set<bigint>;
  listings: Set<bigint>;
  arbiterSets: Set<number>;
  ledger: Set<string>;
}

export interface SyncResult {
  fromBlock: bigint;
  toBlock: bigint;
  head: bigint;
  events: number;
  applied: number;
  quarantined: number;
}

export type DeploymentChangePolicy = "fail" | "restart";

export interface QuarantinedEvent {
  contract: string;
  eventName: string;
  blockNumber: string;
  logIndex: number;
  txHash: string;
  stage: "journal" | "reduce";
  error: string;
}

export const MAX_TRACKED_QUARANTINE = 100;

export interface IndexerOptions {
  db: Database;
  publicClient: PublicClient;
  chainId: number;
  deployment: SquareDeployment;
  startBlock: bigint;
  batchBlocks: bigint;
  logger: Logger;
  metrics?: Metrics;
  onDeploymentChange?: DeploymentChangePolicy;
}

function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

function jobIdOf(event: SquareEvent): bigint | null {
  const args = event.args as Record<string, unknown>;
  const jobId = args["jobId"];
  return typeof jobId === "bigint" ? jobId : null;
}

function emptyDirty(): Dirty {
  return { jobs: new Set(), disputes: new Set(), listings: new Set(), arbiterSets: new Set(), ledger: new Set() };
}

export class Indexer {
  private current: IndexerState = emptyState();
  private readonly persistedLedger = new Map<string, bigint>();
  private readonly addresses: Address[];
  private readonly quarantined: QuarantinedEvent[] = [];
  private cursor: bigint | null = null;
  private lastHead: bigint | null = null;
  private syncedAt: number | null = null;
  private windowsMissing = 0;

  constructor(private readonly options: IndexerOptions) {
    const d = options.deployment;
    this.addresses = [d.squareJob, d.keeperEvaluator, d.arbitration, d.claimMarket, d.squareHook];
  }

  get state(): IndexerState {
    return this.current;
  }

  get lastIndexedBlock(): bigint | null {
    return this.cursor;
  }

  get chainHead(): bigint {
    return this.lastHead ?? 0n;
  }

  get sampledChainHead(): bigint | null {
    return this.lastHead;
  }

  get lastSyncAt(): number | null {
    return this.syncedAt;
  }

  get quarantinedEvents(): readonly QuarantinedEvent[] {
    return this.quarantined;
  }

  get missingWindowEvents(): number {
    return this.windowsMissing;
  }

  async start(): Promise<void> {
    const redeployed = await this.deploymentChanges();
    if (redeployed.length > 0) {
      const summary = redeployed
        .map((change) => `${change.contract} checkpointed at ${change.stored} but the deployment says ${change.current}`)
        .join("; ");
      if ((this.options.onDeploymentChange ?? "fail") === "fail") {
        throw new Error(
          `indexer checkpoint belongs to a different deployment on chain ${this.options.chainId}: ${summary}. ` +
            "Point DATABASE_URL at a fresh database, or set ON_DEPLOYMENT_CHANGE=restart to delete this chain's derived rows " +
            `(${DERIVED_TABLES.join(", ")}) and reindex from START_BLOCK.`,
        );
      }
      this.options.logger.warn("indexer.deployment_changed", { chainId: this.options.chainId, reason: summary });
      const cleared = await this.clearDerivedRows();
      this.options.logger.warn("indexer.deployment_rows_cleared", {
        chainId: this.options.chainId,
        count: cleared,
        reason: `deleted ${cleared} derived rows of the earlier deployment from ${DERIVED_TABLES.join(", ")} before reindexing`,
      });
      this.current = emptyState();
      this.persistedLedger.clear();
      this.cursor = null;
      this.options.logger.info("indexer.started", { chainId: this.options.chainId, blockNumber: 0, count: this.current.jobs.size });
      return;
    }
    await this.replayJournal();
    const checkpoint = await checkpoints.get(this.options.db, this.options.chainId, "SquareJob");
    this.cursor = checkpoint ? checkpoint.lastBlock : null;
    this.options.logger.info("indexer.started", {
      chainId: this.options.chainId,
      blockNumber: this.cursor === null ? 0 : Number(this.cursor),
      count: this.current.jobs.size,
    });
  }

  private async clearDerivedRows(): Promise<number> {
    return this.options.db.transaction(async (tx) => {
      let deleted = 0;
      for (const table of DERIVED_TABLES) {
        const { rowCount } = await tx.query(`delete from ${table} where chain_id = $1`, [this.options.chainId]);
        deleted += rowCount;
      }
      return deleted;
    });
  }

  private async deploymentChanges(): Promise<Array<{ contract: IndexedContract; stored: Address; current: Address }>> {
    const changes: Array<{ contract: IndexedContract; stored: Address; current: Address }> = [];
    for (const contract of CONTRACTS) {
      const checkpoint = await checkpoints.get(this.options.db, this.options.chainId, contract);
      if (checkpoint === null) continue;
      const current = this.addressOf(contract);
      if (checkpoint.address.toLowerCase() !== current.toLowerCase()) {
        changes.push({ contract, stored: checkpoint.address as Address, current });
      }
    }
    return changes;
  }

  private async replayJournal(): Promise<void> {
    const { rows } = await this.options.db.query<JournalRow>(
      "select block_number, log_index, tx_hash, args from job_events where chain_id = $1 order by block_number, log_index",
      [this.options.chainId],
    );
    const logs: Log[] = rows.map((row) => ({
      address: row.args.raw.address,
      topics: row.args.raw.topics,
      data: row.args.raw.data,
      blockNumber: BigInt(row.block_number),
      logIndex: row.log_index,
      transactionHash: `0x${Buffer.from(row.tx_hash).toString("hex")}` as Hex,
      transactionIndex: 0,
      blockHash: null,
      removed: false,
    })) as Log[];
    for (const event of decodeSquareLogs(logs, this.options.deployment)) {
      try {
        applyEvent(this.current, event, (notice) => this.observe(notice, false));
      } catch (error) {
        this.quarantine(event, "reduce", error);
      }
    }
    for (const [key, amount] of this.current.ledger) this.persistedLedger.set(key, amount);
  }

  private observe(notice: ReducerNotice, counted: boolean): void {
    const { logger, metrics } = this.options;
    if (notice.code === "windowsMissing") {
      this.windowsMissing += 1;
      logger.warn("indexer.windows_missing", {
        jobId: notice.jobId.toString(),
        reason: "SubmissionTimed arrived with no configured challenge window, START_BLOCK is after KeeperEvaluator deployment",
      });
      return;
    }
    if (notice.code === "hookFailed") {
      logger.error("indexer.hook_write_failed", {
        jobId: notice.jobId.toString(),
        reason: `the kernel call to hook ${notice.hook} for selector ${notice.selector} did not complete`,
      });
      if (counted) metrics?.recordHookWriteFailure("hookCall");
      return;
    }
    if (notice.code === "reputationWriteFailed") {
      logger.error("indexer.hook_write_failed", { jobId: notice.jobId.toString(), reason: "reputation" });
      if (counted) metrics?.recordHookWriteFailure("reputation");
      return;
    }
    logger.error("indexer.hook_write_failed", { jobId: notice.jobId.toString(), reason: "validation" });
    if (counted) metrics?.recordHookWriteFailure("validation");
  }

  private quarantine(event: SquareEvent, stage: "journal" | "reduce", error: unknown): void {
    const entry: QuarantinedEvent = {
      contract: event.contract,
      eventName: event.eventName,
      blockNumber: (event.blockNumber ?? 0n).toString(),
      logIndex: event.logIndex ?? 0,
      txHash: event.transactionHash ?? "0x",
      stage,
      error: error instanceof Error ? error.message : String(error),
    };
    this.quarantined.push(entry);
    if (this.quarantined.length > MAX_TRACKED_QUARANTINE) this.quarantined.shift();
    this.options.metrics?.recordQuarantinedEvent(event.contract, event.eventName);
    this.options.logger.error("indexer.event_quarantined", {
      blockNumber: Number(event.blockNumber ?? 0n),
      reason: `${event.contract}.${event.eventName} at log ${entry.logIndex} failed at the ${stage} stage: ${entry.error}`,
    });
  }

  async syncOnce(): Promise<SyncResult | null> {
    const head = await this.options.publicClient.getBlockNumber({ cacheTime: 0 });
    this.lastHead = head;
    this.options.metrics?.setChainHead(head);
    const from = this.cursor === null ? this.options.startBlock : this.cursor + 1n;
    if (from > head) {
      this.options.metrics?.setIndexerHead(this.cursor ?? 0n);
      this.syncedAt = Date.now();
      return null;
    }
    const to = from + this.options.batchBlocks - 1n < head ? from + this.options.batchBlocks - 1n : head;
    const logs = await this.options.publicClient.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
    const events = decodeSquareLogs(logs, this.options.deployment);
    const batch = await this.applyBatch(events, to);
    this.cursor = to;
    this.syncedAt = Date.now();
    this.options.metrics?.setIndexerHead(to);
    this.options.logger.info("indexer.synced", { blockNumber: Number(to), count: events.length, applied: batch.applied });
    return { fromBlock: from, toBlock: to, head, events: events.length, applied: batch.applied, quarantined: batch.quarantined };
  }

  private async applyBatch(events: SquareEvent[], toBlock: bigint): Promise<{ applied: number; quarantined: number }> {
    const { db, chainId } = this.options;
    const dirty = emptyDirty();
    const draft = events.length === 0 ? this.current : cloneState(this.current);
    const stagedLedger = new Map<string, bigint>();
    const failures: Array<{ event: SquareEvent; stage: "journal" | "reduce"; error: unknown }> = [];
    const notices: ReducerNotice[] = [];
    let applied = 0;
    await db.transaction(async (tx) => {
      for (const event of events) {
        let inserted = false;
        try {
          inserted = await tx.transaction((scoped) =>
            jobEvents.insertIfAbsent(scoped, {
              chainId,
              blockNumber: event.blockNumber ?? 0n,
              logIndex: event.logIndex ?? 0,
              txHash: event.transactionHash ?? ("0x" + "00".repeat(32) as Hex),
              contract: event.contract,
              name: event.eventName,
              jobId: jobIdOf(event),
              args: {
                raw: { address: event.address, topics: event.topics as Hex[], data: event.data },
                decoded: toJson(event.args),
              } as never,
            }),
          );
        } catch (error) {
          failures.push({ event, stage: "journal", error });
          continue;
        }
        if (!inserted) continue;
        try {
          this.applyAndTrack(event, draft, dirty, (notice) => notices.push(notice));
          applied += 1;
        } catch (error) {
          failures.push({ event, stage: "reduce", error });
        }
      }
      await this.persist(tx, draft, dirty, toBlock, stagedLedger);
      for (const contract of CONTRACTS) {
        await checkpoints.set(tx, { chainId, contract, address: this.addressOf(contract), lastBlock: toBlock });
      }
    });
    this.current = draft;
    for (const [key, amount] of stagedLedger) this.persistedLedger.set(key, amount);
    for (const notice of notices) this.observe(notice, true);
    for (const failure of failures) this.quarantine(failure.event, failure.stage, failure.error);
    return { applied, quarantined: failures.length };
  }

  private addressOf(contract: IndexedContract): Address {
    const d = this.options.deployment;
    switch (contract) {
      case "SquareJob":
        return d.squareJob;
      case "KeeperEvaluator":
        return d.keeperEvaluator;
      case "Arbitration":
        return d.arbitration;
      case "ClaimMarket":
        return d.claimMarket;
      case "SquareHook":
        return d.squareHook;
    }
  }

  private applyAndTrack(event: SquareEvent, draft: IndexerState, dirty: Dirty, notice: (notice: ReducerNotice) => void): void {
    const ledgerBefore = new Map(draft.ledger);
    applyEvent(draft, event, notice);
    const jobId = jobIdOf(event);
    if (jobId !== null) {
      if (draft.jobs.has(jobId)) dirty.jobs.add(jobId);
      if (draft.disputes.has(jobId)) dirty.disputes.add(jobId);
      if (draft.listings.has(jobId)) dirty.listings.add(jobId);
    }
    if (event.contract === "Arbitration" && event.eventName === "ArbitersUpdated") dirty.arbiterSets.add(event.args.version);
    for (const [key, amount] of draft.ledger) {
      if (ledgerBefore.get(key) !== amount) dirty.ledger.add(key);
    }
  }

  private async persist(tx: Database, draft: IndexerState, dirty: Dirty, block: bigint, stagedLedger: Map<string, bigint>): Promise<void> {
    const chainId = this.options.chainId;
    for (const jobId of dirty.jobs) {
      const job = draft.jobs.get(jobId);
      if (!job) continue;
      await jobs.upsert(tx, {
        chainId,
        jobId,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        hook: job.hook,
        description: job.description,
        budget: job.budget,
        status: job.status,
        expiredAt: job.expiredAt,
        createdAt: job.createdAt,
        fundedAt: job.fundedAt,
        submittedAt: job.submittedAt,
        challengeEnd: job.challengeEnd,
        platformFeeBp: job.platformFeeBP,
        evaluatorFeeBp: job.evaluatorFeeBP,
        deliverable: job.deliverable,
        payee: job.payee,
        providerBps: job.providerBps,
        reason: job.reason,
        disputed: job.disputed,
        agentId: job.agentId,
        updatedBlock: job.updatedBlock,
        refundReason: job.refundReason,
      });
    }
    for (const jobId of dirty.disputes) {
      const d = draft.disputes.get(jobId);
      if (!d) continue;
      await disputes.upsert(tx, {
        chainId,
        jobId,
        disputer: d.disputer,
        bond: d.bond,
        disputedAt: d.disputedAt,
        resolveBy: d.resolveBy,
        setVersion: d.setVersion,
        outcome: d.outcome,
        providerBps: d.providerBps,
        closed: d.closed,
        updatedBlock: d.updatedBlock,
      });
    }
    for (const jobId of dirty.listings) {
      const l = draft.listings.get(jobId);
      if (!l) continue;
      await claimListings.upsert(tx, {
        chainId,
        jobId,
        seller: l.seller,
        buyer: l.buyer,
        price: l.price,
        faceValue: l.faceValue,
        status: l.status,
        updatedBlock: l.updatedBlock,
      });
    }
    for (const version of dirty.arbiterSets) {
      const set = draft.arbiterSets.get(version);
      if (!set) continue;
      await arbiterSets.upsert(tx, { chainId, version, arbiters: set.arbiters, threshold: set.threshold });
    }
    for (const key of dirty.ledger) {
      const amount = draft.ledger.get(key) ?? 0n;
      const before = this.persistedLedger.get(key) ?? 0n;
      const delta = amount - before;
      if (delta === 0n) continue;
      const [contract, account] = key.split(":") as [IndexedContract, Address];
      await ledgerBalances.adjust(tx, { chainId, contract, account, delta, updatedBlock: block });
      stagedLedger.set(key, amount);
    }
  }

  async run(pollIntervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.syncOnce();
        if (result && result.toBlock < result.head) continue;
      } catch (error) {
        this.options.logger.error("indexer.sync_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}

export function ledgerBalanceOf(state: IndexerState, contract: "SquareJob" | "Arbitration", account: Address): bigint {
  return state.ledger.get(ledgerKey(contract, account)) ?? 0n;
}
