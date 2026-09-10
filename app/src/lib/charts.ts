import { JobStatus } from "@squaresdk/core";
import { jobPhase, type JobPhase } from "./phase";
import type { JobSummary } from "./square";

export const chartColors = {
  carbon: "#181925",
  graphite: "#666666",
  ash: "#999999",
  fog: "#e8e8e8",
  mist: "#f5f5f5",
  paper: "#ffffff",
  lavender: "#918df6",
  iris: "#9580ff",
  mint: "#33c758",
  mintWash: "#def6e4",
  amber: "#ffa600",
  sky: "#2c78fc",
  magenta: "#d6409f",
  ember: "#ff3e00",
} as const;

export const chartFont = "OpenRunde, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export const phaseColor: Record<JobPhase, string> = {
  open: chartColors.sky,
  funded: chartColors.sky,
  submitted: chartColors.amber,
  "in-window": chartColors.amber,
  finalizable: chartColors.amber,
  disputed: chartColors.magenta,
  completed: chartColors.mint,
  rejected: chartColors.magenta,
  expired: chartColors.ash,
};

export const PHASE_ORDER: JobPhase[] = ["open", "funded", "submitted", "in-window", "finalizable", "disputed", "completed", "rejected", "expired"];

export const HOUR = 3_600;
export const DAY = 86_400;

export function bucketSize(spanSeconds: number): number {
  return spanSeconds <= 3 * DAY ? HOUR : DAY;
}

export function bucketOf(timestamp: number, size: number): number {
  return Math.floor(timestamp / size) * size;
}

export function usdc(value: bigint): number {
  return Number(value) / 1_000_000;
}

export interface FlowPoint {
  time: number;
  funded: number;
  submitted: number;
  cumulativeFunded: number;
  cumulativeSubmitted: number;
}

export interface FlowSeries {
  bucket: number;
  points: FlowPoint[];
  totalFunded: number;
  totalSubmitted: number;
}

export function escrowFlow(jobs: readonly JobSummary[]): FlowSeries {
  const funded = jobs.filter((job) => job.fundedAt > 0);
  const submitted = jobs.filter((job) => job.submittedAt > 0);
  const stamps = [...funded.map((job) => job.fundedAt), ...submitted.map((job) => job.submittedAt)];
  if (stamps.length === 0) return { bucket: HOUR, points: [], totalFunded: 0, totalSubmitted: 0 };
  const span = Math.max(...stamps) - Math.min(...stamps);
  const bucket = bucketSize(span);
  const byBucket = new Map<number, { funded: number; submitted: number }>();
  const touch = (time: number) => {
    const key = bucketOf(time, bucket);
    const entry = byBucket.get(key) ?? { funded: 0, submitted: 0 };
    byBucket.set(key, entry);
    return entry;
  };
  for (const job of funded) touch(job.fundedAt).funded += usdc(job.budget);
  for (const job of submitted) touch(job.submittedAt).submitted += usdc(job.budget);
  const first = Math.min(...byBucket.keys());
  const last = Math.max(...byBucket.keys());
  const points: FlowPoint[] = [];
  let cumulativeFunded = 0;
  let cumulativeSubmitted = 0;
  for (let time = first; time <= last; time += bucket) {
    const entry = byBucket.get(time) ?? { funded: 0, submitted: 0 };
    cumulativeFunded += entry.funded;
    cumulativeSubmitted += entry.submitted;
    points.push({ time, funded: entry.funded, submitted: entry.submitted, cumulativeFunded, cumulativeSubmitted });
  }
  return { bucket, points, totalFunded: cumulativeFunded, totalSubmitted: cumulativeSubmitted };
}

export interface PhaseSlice {
  phase: JobPhase;
  label: string;
  count: number;
  budget: number;
  color: string;
}

export function phaseBreakdown(jobs: readonly JobSummary[], now: number, labels: Record<JobPhase, string>): PhaseSlice[] {
  const slices = new Map<JobPhase, PhaseSlice>();
  for (const phase of PHASE_ORDER) slices.set(phase, { phase, label: labels[phase], count: 0, budget: 0, color: phaseColor[phase] });
  for (const job of jobs) {
    const slice = slices.get(jobPhase(job, now));
    if (!slice) continue;
    slice.count += 1;
    slice.budget += usdc(job.budget);
  }
  return [...slices.values()].filter((slice) => slice.count > 0);
}

export interface PayoutSplit {
  budget: number;
  platformFee: number;
  evaluatorFee: number;
  net: number;
  providerShare: number;
  clientShare: number;
  providerBps: number;
}

export function payoutSplit(record: { budget: bigint; platformFeeBP: number; evaluatorFeeBP: number; providerBps: number; status: number }, netPayout: bigint): PayoutSplit {
  const budget = usdc(record.budget);
  const platformFee = (budget * record.platformFeeBP) / 10_000;
  const evaluatorFee = (budget * record.evaluatorFeeBP) / 10_000;
  const net = netPayout > 0n ? usdc(netPayout) : Math.max(0, budget - platformFee - evaluatorFee);
  const providerBps = record.status === JobStatus.Completed ? record.providerBps : 10_000;
  const providerShare = (net * providerBps) / 10_000;
  return { budget, platformFee, evaluatorFee, net, providerShare, clientShare: net - providerShare, providerBps };
}

export interface FeeTotals {
  platform: number;
  evaluator: number;
  netPaid: number;
  refunded: number;
  splitToClient: number;
  completed: number;
  rejected: number;
}

export function feeTotals(jobs: readonly JobSummary[]): FeeTotals {
  const totals: FeeTotals = { platform: 0, evaluator: 0, netPaid: 0, refunded: 0, splitToClient: 0, completed: 0, rejected: 0 };
  for (const job of jobs) {
    if (job.status === JobStatus.Completed) {
      const budget = usdc(job.budget);
      const platform = (budget * job.platformFeeBP) / 10_000;
      const evaluator = (budget * job.evaluatorFeeBP) / 10_000;
      const net = budget - platform - evaluator;
      const payeeShare = (net * job.providerBps) / 10_000;
      const clientShare = net - payeeShare;
      totals.platform += platform;
      totals.evaluator += evaluator;
      totals.netPaid += payeeShare;
      totals.splitToClient += clientShare;
      totals.refunded += clientShare;
      totals.completed += 1;
    } else if (job.status === JobStatus.Rejected && job.fundedAt > 0) {
      totals.refunded += usdc(job.budget);
      totals.rejected += 1;
    }
  }
  return totals;
}

export interface ClockSegment {
  key: string;
  label: string;
  from: number;
  to: number;
  color: string;
  state: "done" | "live" | "future";
}

export interface ClockMark {
  key: string;
  label: string;
  at: number;
  emphasis?: boolean;
}

export interface SettlementClock {
  start: number;
  end: number;
  segments: ClockSegment[];
  marks: ClockMark[];
  now: number;
  expiresAt: number;
  expiryOnScale: boolean;
}

export function settlementClock(input: {
  createdAt: number;
  fundedAt: number;
  submittedAt: number;
  expiredAt: number;
  challengeEnd: number;
  disputedAt: number;
  resolveBy: number;
  status: number;
  now: number;
}): SettlementClock {
  const { now } = input;
  const segments: ClockSegment[] = [];
  const marks: ClockMark[] = [{ key: "created", label: "Created", at: input.createdAt }];
  const state = (from: number, to: number): ClockSegment["state"] => (now >= to ? "done" : now >= from ? "live" : "future");
  const settled = input.status >= JobStatus.Completed;
  const fundedAt = input.fundedAt > 0 ? input.fundedAt : null;
  const submittedAt = input.submittedAt > 0 ? input.submittedAt : null;
  const openEnd = fundedAt ?? (settled ? input.createdAt : Math.min(now, input.expiredAt));
  segments.push({ key: "open", label: "Open", from: input.createdAt, to: Math.max(openEnd, input.createdAt), color: chartColors.sky, state: fundedAt ? "done" : state(input.createdAt, input.expiredAt) });
  if (fundedAt) {
    marks.push({ key: "funded", label: "Funded", at: fundedAt });
    const fundedEnd = submittedAt ?? (settled ? fundedAt : Math.min(now, input.expiredAt));
    segments.push({ key: "funded", label: "Funded", from: fundedAt, to: Math.max(fundedEnd, fundedAt), color: chartColors.iris, state: submittedAt ? "done" : state(fundedAt, input.expiredAt) });
  }
  if (submittedAt) {
    marks.push({ key: "submitted", label: "Submitted", at: submittedAt });
    if (input.challengeEnd > submittedAt) {
      segments.push({ key: "challenge", label: "Challenge window", from: submittedAt, to: input.challengeEnd, color: chartColors.amber, state: state(submittedAt, input.challengeEnd) });
      marks.push({ key: "window", label: "Window closes", at: input.challengeEnd });
    }
    if (input.disputedAt > 0 && input.resolveBy > input.disputedAt) {
      segments.push({ key: "dispute", label: "Dispute window", from: input.disputedAt, to: input.resolveBy, color: chartColors.magenta, state: state(input.disputedAt, input.resolveBy) });
      marks.push({ key: "disputed", label: "Disputed", at: input.disputedAt, emphasis: true });
      marks.push({ key: "resolve", label: "Resolve by", at: input.resolveBy });
    }
  }
  const activityEnd = Math.max(...segments.map((segment) => segment.to), ...marks.map((mark) => mark.at), settled ? input.createdAt : Math.min(now, input.expiredAt));
  const activitySpan = Math.max(activityEnd - input.createdAt, 60);
  const expiryOnScale = input.expiredAt - input.createdAt <= activitySpan * 4;
  if (expiryOnScale) marks.push({ key: "expires", label: "Expires", at: input.expiredAt });
  const end = expiryOnScale ? Math.max(input.expiredAt, activityEnd) : input.createdAt + activitySpan * 1.08;
  return { start: input.createdAt, end: Math.max(end, input.createdAt + 1), segments, marks, now, expiresAt: input.expiredAt, expiryOnScale };
}

export interface ClockLabel {
  key: string;
  x: number;
  row: number;
  names: string[];
  at: number;
  emphasis: boolean;
}

export function clusterMarks(marks: readonly (ClockMark & { x: number })[], minGap = 9): ClockLabel[] {
  const sorted = [...marks].sort((left, right) => left.x - right.x);
  const clusters: ClockLabel[] = [];
  for (const mark of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && mark.x - last.x < minGap) {
      last.names.push(mark.label);
      last.emphasis = last.emphasis || mark.emphasis === true;
      continue;
    }
    clusters.push({ key: mark.key, x: mark.x, row: 0, names: [mark.label], at: mark.at, emphasis: mark.emphasis === true });
  }
  let previousX = Number.NEGATIVE_INFINITY;
  let previousRow = 1;
  for (const cluster of clusters) {
    cluster.row = cluster.x - previousX < minGap * 2 ? (previousRow === 0 ? 1 : 0) : 0;
    previousX = cluster.x;
    previousRow = cluster.row;
  }
  return clusters;
}

export function formatCompactUsdc(value: number): string {
  const trim = (text: string) => (text.includes(".") ? text.replace(/\.?0+$/, "") : text);
  if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(2))}M`;
  if (value >= 10_000) return `${trim((value / 1_000).toFixed(1))}k`;
  if (value >= 100) return trim(value.toFixed(0));
  if (value >= 1) return trim(value.toFixed(2));
  if (value === 0) return "0";
  return trim(value.toFixed(4));
}
