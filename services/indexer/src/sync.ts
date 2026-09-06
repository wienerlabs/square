import type { Address, Hex, Log, PublicClient } from "viem";
import { decodeSquareLogs, type SquareDeployment, type SquareEvent } from "@squaresdk/core";
import { arbiterSets, checkpoints, claimListings, disputes, jobEvents, jobs, ledgerBalances, type Database, type IndexedContract } from "@squaresdk/data";
import type { Logger, Metrics } from "@squaresdk/observability";
import { applyEvent, emptyState, ledgerKey, type IndexerState } from "./reducer.js";

const CONTRACTS: IndexedContract[] = ["SquareJob", "KeeperEvaluator", "Arbitration", "ClaimMarket", "SquareHook"];

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
}

export interface IndexerOptions {
  db: Database;
  publicClient: PublicClient;
  chainId: number;
  deployment: SquareDeployment;
  startBlock: bigint;
  batchBlocks: bigint;
  logger: Logger;
  metrics?: Metrics;
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
  readonly state: IndexerState = emptyState();
  private readonly persistedLedger = new Map<string, bigint>();
  private readonly addresses: Address[];
  private cursor: bigint | null = null;
  private lastHead = 0n;

  constructor(private readonly options: IndexerOptions) {
    const d = options.deployment;
    this.addresses = [d.squareJob, d.keeperEvaluator, d.arbitration, d.claimMarket, d.squareHook];
  }

  get lastIndexedBlock(): bigint | null {
    return this.cursor;
  }

  get chainHead(): bigint {
    return this.lastHead;
  }

  async start(): Promise<void> {
    await this.replayJournal();
    const checkpoint = await checkpoints.get(this.options.db, this.options.chainId, "SquareJob");
    this.cursor = checkpoint ? checkpoint.lastBlock : null;
    this.options.logger.info("indexer.started", {
      chainId: this.options.chainId,
      blockNumber: this.cursor === null ? 0 : Number(this.cursor),
      count: this.state.jobs.size,
    });
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
    for (const event of decodeSquareLogs(logs, this.options.deployment)) applyEvent(this.state, event);
    for (const [key, amount] of this.state.ledger) this.persistedLedger.set(key, amount);
  }

  async syncOnce(): Promise<SyncResult | null> {
    const head = await this.options.publicClient.getBlockNumber({ cacheTime: 0 });
    this.lastHead = head;
    this.options.metrics?.setChainHead(head);
    const from = this.cursor === null ? this.options.startBlock : this.cursor + 1n;
    if (from > head) {
      this.options.metrics?.setIndexerHead(this.cursor ?? 0n);
      return null;
    }
    const to = from + this.options.batchBlocks - 1n < head ? from + this.options.batchBlocks - 1n : head;
    const logs = await this.options.publicClient.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
    const events = decodeSquareLogs(logs, this.options.deployment);
    const applied = await this.applyBatch(events, to);
    this.cursor = to;
    this.options.metrics?.setIndexerHead(to);
    this.options.logger.info("indexer.synced", { blockNumber: Number(to), count: events.length, applied });
    return { fromBlock: from, toBlock: to, head, events: events.length, applied };
  }

  private async applyBatch(events: SquareEvent[], toBlock: bigint): Promise<number> {
    const { db, chainId } = this.options;
    const dirty = emptyDirty();
    let applied = 0;
    await db.transaction(async (tx) => {
      for (const event of events) {
        const inserted = await jobEvents.insertIfAbsent(tx, {
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
        });
        if (!inserted) continue;
        applied += 1;
        this.applyAndTrack(event, dirty);
      }
      await this.persist(tx, dirty, toBlock);
      for (const contract of CONTRACTS) {
        await checkpoints.set(tx, { chainId, contract, address: this.addressOf(contract), lastBlock: toBlock });
      }
    });
    return applied;
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

  private applyAndTrack(event: SquareEvent, dirty: Dirty): void {
    const ledgerBefore = new Map(this.state.ledger);
    applyEvent(this.state, event);
    const jobId = jobIdOf(event);
    if (jobId !== null) {
      if (this.state.jobs.has(jobId)) dirty.jobs.add(jobId);
      if (this.state.disputes.has(jobId)) dirty.disputes.add(jobId);
      if (this.state.listings.has(jobId)) dirty.listings.add(jobId);
    }
    if (event.contract === "Arbitration" && event.eventName === "ArbitersUpdated") dirty.arbiterSets.add(event.args.version);
    for (const [key, amount] of this.state.ledger) {
      if (ledgerBefore.get(key) !== amount) dirty.ledger.add(key);
    }
  }

  private async persist(tx: Database, dirty: Dirty, block: bigint): Promise<void> {
    const chainId = this.options.chainId;
    for (const jobId of dirty.jobs) {
      const job = this.state.jobs.get(jobId);
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
      });
    }
    for (const jobId of dirty.disputes) {
      const d = this.state.disputes.get(jobId);
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
      const l = this.state.listings.get(jobId);
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
      const set = this.state.arbiterSets.get(version);
      if (!set) continue;
      await arbiterSets.upsert(tx, { chainId, version, arbiters: set.arbiters, threshold: set.threshold });
    }
    for (const key of dirty.ledger) {
      const amount = this.state.ledger.get(key) ?? 0n;
      const before = this.persistedLedger.get(key) ?? 0n;
      const delta = amount - before;
      if (delta === 0n) continue;
      const [contract, account] = key.split(":") as [IndexedContract, Address];
      await ledgerBalances.adjust(tx, { chainId, contract, account, delta, updatedBlock: block });
      this.persistedLedger.set(key, amount);
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
