import type { Address, Hex } from "viem";
import { JobStatus, type SquareEvent } from "@squaresdk/core";
import { stripNullCharacters } from "@squaresdk/data";

export interface JobState {
  jobId: bigint;
  client: Address;
  provider: Address | null;
  evaluator: Address;
  hook: Address | null;
  description: string;
  budget: bigint;
  status: number;
  expiredAt: bigint;
  createdAt: bigint;
  fundedAt: bigint | null;
  submittedAt: bigint | null;
  challengeEnd: bigint | null;
  platformFeeBP: number | null;
  evaluatorFeeBP: number | null;
  deliverable: Hex | null;
  payee: Address | null;
  providerBps: number | null;
  reason: Hex | null;
  disputed: boolean;
  agentId: bigint | null;
  refundReason: string | null;
  updatedBlock: bigint;
}

export interface DisputeState {
  jobId: bigint;
  disputer: Address;
  bond: bigint;
  disputedAt: bigint;
  resolveBy: bigint;
  setVersion: number;
  approvals: Map<Hex, bigint>;
  outcome: number | null;
  providerBps: number | null;
  closed: boolean;
  updatedBlock: bigint;
}

export interface ListingState {
  jobId: bigint;
  seller: Address;
  buyer: Address | null;
  price: bigint;
  faceValue: bigint;
  status: number;
  updatedBlock: bigint;
}

export interface WindowState {
  effectiveFrom: bigint;
  challengeWindow: bigint;
  disputeWindow: bigint;
}

export interface ArbiterSetState {
  version: number;
  arbiters: Address[];
  threshold: number;
}

export interface IndexerState {
  jobs: Map<bigint, JobState>;
  disputes: Map<bigint, DisputeState>;
  listings: Map<bigint, ListingState>;
  ledger: Map<string, bigint>;
  windows: WindowState[];
  arbiterSets: Map<number, ArbiterSetState>;
}

export const ListingStatus = { None: 0, Listed: 1, Sold: 2, Cancelled: 3 } as const;

export type ReducerNotice =
  | { code: "windowsMissing"; jobId: bigint; submittedAt: bigint }
  | { code: "reputationWriteFailed"; jobId: bigint; agentId: bigint }
  | { code: "validationWriteFailed"; jobId: bigint; requestHash: Hex }
  | { code: "hookFailed"; jobId: bigint; hook: Address; selector: Hex }
  | { code: "releaseUnconfirmed"; jobId: bigint; payee: Address; amount: bigint };

export const REFUND_REASON_PAYOUT_UNRESOLVABLE = "payoutUnresolvable";

export type NoticeSink = (notice: ReducerNotice) => void;

const ignoreNotice: NoticeSink = () => {};

export function emptyState(): IndexerState {
  return { jobs: new Map(), disputes: new Map(), listings: new Map(), ledger: new Map(), windows: [], arbiterSets: new Map() };
}

export function ledgerKey(contract: "SquareJob" | "Arbitration", account: Address): string {
  return `${contract}:${account.toLowerCase()}`;
}

export function windowFor(windows: WindowState[], submittedAt: bigint): WindowState | undefined {
  for (let i = windows.length - 1; i >= 0; i--) {
    const window = windows[i];
    if (window && window.effectiveFrom <= submittedAt) return window;
  }
  return windows[0];
}

const zero: Address = "0x0000000000000000000000000000000000000000";

function nullable(address: Address): Address | null {
  return address.toLowerCase() === zero ? null : address;
}

function credit(state: IndexerState, contract: "SquareJob" | "Arbitration", account: Address, delta: bigint): void {
  const key = ledgerKey(contract, account);
  state.ledger.set(key, (state.ledger.get(key) ?? 0n) + delta);
}

function requireJob(state: IndexerState, jobId: bigint): JobState {
  const job = state.jobs.get(jobId);
  if (!job) throw new Error(`event for unknown job ${jobId}; the log stream is out of order or incomplete`);
  return job;
}

function requireDispute(state: IndexerState, jobId: bigint): DisputeState {
  const dispute = state.disputes.get(jobId);
  if (!dispute) throw new Error(`event for unknown dispute on job ${jobId}`);
  return dispute;
}

export function applyEvent(state: IndexerState, event: SquareEvent, notice: NoticeSink = ignoreNotice): void {
  const block = event.blockNumber ?? 0n;
  switch (event.contract) {
    case "SquareJob":
      applyKernel(state, event, block, notice);
      return;
    case "KeeperEvaluator":
      applyKeeper(state, event, block);
      return;
    case "Arbitration":
      applyArbitration(state, event, block);
      return;
    case "ClaimMarket":
      applyMarket(state, event, block);
      return;
    case "SquareHook":
      applyHook(state, event, block, notice);
      return;
  }
}

function applyKernel(state: IndexerState, event: Extract<SquareEvent, { contract: "SquareJob" }>, block: bigint, notice: NoticeSink): void {
  switch (event.eventName) {
    case "JobCreated": {
      const a = event.args;
      state.jobs.set(a.jobId, {
        jobId: a.jobId,
        client: a.client,
        provider: nullable(a.provider),
        evaluator: a.evaluator,
        hook: nullable(a.hook),
        description: "",
        budget: 0n,
        status: JobStatus.Open,
        expiredAt: a.expiredAt,
        createdAt: 0n,
        fundedAt: null,
        submittedAt: null,
        challengeEnd: null,
        platformFeeBP: null,
        evaluatorFeeBP: null,
        deliverable: null,
        payee: null,
        providerBps: null,
        reason: null,
        disputed: false,
        agentId: null,
        refundReason: null,
        updatedBlock: block,
      });
      return;
    }
    case "JobDescribed": {
      const job = requireJob(state, event.args.jobId);
      job.description = stripNullCharacters(event.args.description);
      job.createdAt = BigInt(event.args.createdAt);
      job.updatedBlock = block;
      return;
    }
    case "ProviderSet": {
      const job = requireJob(state, event.args.jobId);
      job.provider = event.args.provider;
      job.updatedBlock = block;
      return;
    }
    case "BudgetSet": {
      const job = requireJob(state, event.args.jobId);
      job.budget = event.args.amount;
      job.updatedBlock = block;
      return;
    }
    case "JobFunded": {
      const job = requireJob(state, event.args.jobId);
      job.status = JobStatus.Funded;
      job.budget = event.args.amount;
      job.updatedBlock = block;
      return;
    }
    case "FeesSnapshotted": {
      const job = requireJob(state, event.args.jobId);
      job.platformFeeBP = event.args.platformFeeBP;
      job.evaluatorFeeBP = event.args.evaluatorFeeBP;
      job.fundedAt = BigInt(event.args.fundedAt);
      job.updatedBlock = block;
      return;
    }
    case "JobSubmitted": {
      const job = requireJob(state, event.args.jobId);
      job.status = JobStatus.Submitted;
      job.deliverable = event.args.deliverable;
      job.updatedBlock = block;
      return;
    }
    case "SubmissionTimed": {
      const job = requireJob(state, event.args.jobId);
      job.submittedAt = BigInt(event.args.submittedAt);
      job.expiredAt = BigInt(event.args.expiredAt);
      if (state.windows.length === 0) notice({ code: "windowsMissing", jobId: job.jobId, submittedAt: job.submittedAt });
      const window = windowFor(state.windows, job.submittedAt);
      job.challengeEnd = window ? job.submittedAt + window.challengeWindow : null;
      job.updatedBlock = block;
      return;
    }
    case "JobCompleted": {
      const job = requireJob(state, event.args.jobId);
      job.status = JobStatus.Completed;
      job.reason = event.args.reason;
      job.updatedBlock = block;
      return;
    }
    case "PayoutRouted": {
      const job = requireJob(state, event.args.jobId);
      job.payee = event.args.payee;
      job.providerBps = event.args.providerBps;
      job.updatedBlock = block;
      return;
    }
    case "JobRejected": {
      const job = requireJob(state, event.args.jobId);
      job.status = JobStatus.Rejected;
      job.reason = event.args.reason;
      job.updatedBlock = block;
      return;
    }
    case "JobExpired": {
      const job = requireJob(state, event.args.jobId);
      job.status = JobStatus.Expired;
      job.updatedBlock = block;
      return;
    }
    case "PayoutUnresolvable": {
      const job = requireJob(state, event.args.jobId);
      job.refundReason = REFUND_REASON_PAYOUT_UNRESOLVABLE;
      job.updatedBlock = block;
      return;
    }
    case "HookFailed":
      notice({ code: "hookFailed", jobId: event.args.jobId, hook: event.args.hook, selector: event.args.selector });
      return;
    case "PaymentReleased":
      credit(state, "SquareJob", event.args.provider, event.args.amount);
      return;
    case "Refunded":
      credit(state, "SquareJob", event.args.client, event.args.amount);
      return;
    case "EvaluatorFeePaid":
      credit(state, "SquareJob", event.args.evaluator, event.args.amount);
      return;
    case "PlatformFeeAccrued":
      credit(state, "SquareJob", event.args.treasury, event.args.amount);
      return;
    case "Withdrawn":
      credit(state, "SquareJob", event.args.account, -event.args.amount);
      return;
    default:
      return;
  }
}

function applyKeeper(state: IndexerState, event: Extract<SquareEvent, { contract: "KeeperEvaluator" }>, block: bigint): void {
  switch (event.eventName) {
    case "WindowsConfigured":
      state.windows.push({
        effectiveFrom: BigInt(event.args.effectiveFrom),
        challengeWindow: BigInt(event.args.challengeWindow),
        disputeWindow: BigInt(event.args.disputeWindow),
      });
      return;
    case "DisputeRaised": {
      const job = requireJob(state, event.args.jobId);
      job.disputed = true;
      job.updatedBlock = block;
      return;
    }
    case "DecisionApplied": {
      const job = requireJob(state, event.args.jobId);
      job.disputed = false;
      job.updatedBlock = block;
      const dispute = state.disputes.get(event.args.jobId);
      if (dispute) {
        dispute.closed = true;
        dispute.updatedBlock = block;
      }
      return;
    }
    default:
      return;
  }
}

function applyArbitration(state: IndexerState, event: Extract<SquareEvent, { contract: "Arbitration" }>, block: bigint): void {
  switch (event.eventName) {
    case "ArbitersUpdated":
      state.arbiterSets.set(event.args.version, {
        version: event.args.version,
        arbiters: [...event.args.arbiters],
        threshold: event.args.threshold,
      });
      return;
    case "DisputeOpened":
      state.disputes.set(event.args.jobId, {
        jobId: event.args.jobId,
        disputer: event.args.disputer,
        bond: event.args.bond,
        disputedAt: BigInt(event.args.disputedAt),
        resolveBy: BigInt(event.args.resolveBy),
        setVersion: event.args.setVersion,
        approvals: new Map(),
        outcome: null,
        providerBps: null,
        closed: false,
        updatedBlock: block,
      });
      return;
    case "VoteCast": {
      const dispute = requireDispute(state, event.args.jobId);
      dispute.approvals.set(event.args.resolutionHash, event.args.approvals);
      dispute.updatedBlock = block;
      return;
    }
    case "DecisionReached": {
      const dispute = requireDispute(state, event.args.jobId);
      dispute.outcome = event.args.outcome;
      dispute.providerBps = event.args.providerBps;
      dispute.updatedBlock = block;
      return;
    }
    case "BondSettled":
      credit(state, "Arbitration", event.args.to, event.args.amount);
      return;
    case "BondWithdrawn":
      credit(state, "Arbitration", event.args.account, -event.args.amount);
      return;
    default:
      return;
  }
}

function applyMarket(state: IndexerState, event: Extract<SquareEvent, { contract: "ClaimMarket" }>, block: bigint): void {
  switch (event.eventName) {
    case "ClaimListed":
      state.listings.set(event.args.jobId, {
        jobId: event.args.jobId,
        seller: event.args.seller,
        buyer: null,
        price: event.args.price,
        faceValue: event.args.faceValue,
        status: ListingStatus.Listed,
        updatedBlock: block,
      });
      return;
    case "ClaimBought": {
      const listing = state.listings.get(event.args.jobId);
      if (!listing) throw new Error(`purchase of an unlisted claim on job ${event.args.jobId}`);
      listing.buyer = event.args.buyer;
      listing.status = ListingStatus.Sold;
      listing.updatedBlock = block;
      return;
    }
    case "ClaimCancelled": {
      const listing = state.listings.get(event.args.jobId);
      if (!listing) throw new Error(`cancellation of an unlisted claim on job ${event.args.jobId}`);
      listing.status = ListingStatus.Cancelled;
      listing.updatedBlock = block;
      return;
    }
  }
}

function applyHook(state: IndexerState, event: Extract<SquareEvent, { contract: "SquareHook" }>, block: bigint, notice: NoticeSink): void {
  if (event.eventName === "ReputationWriteFailed") {
    notice({ code: "reputationWriteFailed", jobId: event.args.jobId, agentId: event.args.agentId });
    return;
  }
  if (event.eventName === "ValidationWriteFailed") {
    notice({ code: "validationWriteFailed", jobId: event.args.jobId, requestHash: event.args.requestHash });
    return;
  }
  if (event.eventName === "ReleaseUnconfirmed") {
    notice({ code: "releaseUnconfirmed", jobId: event.args.jobId, payee: event.args.payee, amount: event.args.amount });
    return;
  }
  if (event.eventName !== "AgentBound") return;
  const job = requireJob(state, event.args.jobId);
  job.agentId = event.args.agentId;
  job.updatedBlock = block;
}

export function reduce(events: SquareEvent[], state: IndexerState = emptyState(), notice: NoticeSink = ignoreNotice): IndexerState {
  for (const event of events) applyEvent(state, event, notice);
  return state;
}

export function cloneState(state: IndexerState): IndexerState {
  return {
    jobs: new Map([...state.jobs].map(([jobId, job]) => [jobId, { ...job }])),
    disputes: new Map([...state.disputes].map(([jobId, dispute]) => [jobId, { ...dispute, approvals: new Map(dispute.approvals) }])),
    listings: new Map([...state.listings].map(([jobId, listing]) => [jobId, { ...listing }])),
    ledger: new Map(state.ledger),
    windows: state.windows.map((window) => ({ ...window })),
    arbiterSets: new Map([...state.arbiterSets].map(([version, set]) => [version, { ...set, arbiters: [...set.arbiters] }])),
  };
}

export function openJobs(state: IndexerState): JobState[] {
  return [...state.jobs.values()].filter((job) => job.status === JobStatus.Open || job.status === JobStatus.Funded);
}

export function jobsOfProvider(state: IndexerState, provider: Address): JobState[] {
  const wanted = provider.toLowerCase();
  return [...state.jobs.values()].filter((job) => job.provider?.toLowerCase() === wanted);
}

export function jobsInChallengeWindow(state: IndexerState, now: bigint): JobState[] {
  return [...state.jobs.values()].filter(
    (job) => job.status === JobStatus.Submitted && !job.disputed && job.challengeEnd !== null && now < job.challengeEnd,
  );
}

export function finalizableJobs(state: IndexerState, now: bigint): JobState[] {
  return [...state.jobs.values()].filter(
    (job) => job.status === JobStatus.Submitted && !job.disputed && job.challengeEnd !== null && now >= job.challengeEnd,
  );
}

export function payeeOf(state: IndexerState, jobId: bigint): Address | null {
  const listing = state.listings.get(jobId);
  if (listing && listing.status === ListingStatus.Sold) return listing.buyer;
  return state.jobs.get(jobId)?.provider ?? null;
}
