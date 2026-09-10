import { JobStatus } from "@squaresdk/core";
import type { JobsSnapshot, JobSummary } from "./square";

export interface LiveStats {
  totalJobs: bigint;
  escrowed: bigint;
  settled: bigint;
  completed: number;
  active: number;
  lastActivity: number | null;
  scanned: number;
}

const BPS = 10_000n;

function latest(job: JobSummary): number {
  return Math.max(job.createdAt, job.fundedAt, job.submittedAt);
}

export function released(job: JobSummary): bigint {
  const platformFee = (job.budget * BigInt(job.platformFeeBP)) / BPS;
  const evaluatorFee = (job.budget * BigInt(job.evaluatorFeeBP)) / BPS;
  const net = job.budget - platformFee - evaluatorFee;
  return (net * BigInt(job.providerBps)) / BPS;
}

export function liveStats(snapshot: JobsSnapshot): LiveStats {
  let escrowed = 0n;
  let settled = 0n;
  let completed = 0;
  let active = 0;
  let lastActivity: number | null = null;
  for (const job of snapshot.jobs) {
    const inEscrow = job.status === JobStatus.Funded || job.status === JobStatus.Submitted;
    if (inEscrow) {
      escrowed += job.budget;
      active += 1;
    }
    if (job.status === JobStatus.Completed) {
      settled += released(job);
      completed += 1;
    }
    const seen = latest(job);
    if (seen > 0 && (lastActivity === null || seen > lastActivity)) lastActivity = seen;
  }
  return { totalJobs: snapshot.counter, escrowed, settled, completed, active, lastActivity, scanned: snapshot.scanned };
}

export function relativeTime(from: number, now: number): string {
  const seconds = Math.max(0, now - from);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

export function matchesQuery(job: JobSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (/^#?\d+$/.test(needle)) return job.id.toString() === needle.replace(/^#/, "");
  return job.client.toLowerCase().includes(needle) || job.provider.toLowerCase().includes(needle);
}
