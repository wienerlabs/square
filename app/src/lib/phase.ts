import { JobStatus } from "@squaresdk/core";

export type JobPhase =
  | "open"
  | "funded"
  | "submitted"
  | "in-window"
  | "finalizable"
  | "disputed"
  | "completed"
  | "rejected"
  | "expired";

export function jobPhase(job: { status: number; challengeEnd: number; disputed: boolean }, now: number): JobPhase {
  switch (job.status) {
    case JobStatus.Open:
      return "open";
    case JobStatus.Funded:
      return "funded";
    case JobStatus.Submitted:
      if (job.disputed) return "disputed";
      if (job.challengeEnd > 0 && now >= job.challengeEnd) return "finalizable";
      return job.challengeEnd > 0 ? "in-window" : "submitted";
    case JobStatus.Completed:
      return "completed";
    case JobStatus.Rejected:
      return "rejected";
    case JobStatus.Expired:
      return "expired";
    default:
      return "open";
  }
}

export const PHASE_LABELS: Record<JobPhase, string> = {
  open: "Open",
  funded: "Funded",
  submitted: "Submitted",
  "in-window": "In window",
  finalizable: "Finalizable",
  disputed: "Disputed",
  completed: "Completed",
  rejected: "Rejected",
  expired: "Expired",
};

export const LISTING_LABELS = ["No listing", "Listed", "Sold", "Cancelled"] as const;
export const OUTCOME_LABELS = ["Pending", "Complete", "Reject", "Lapsed"] as const;

export function countVotes(mask: bigint): number {
  let count = 0;
  let value = mask;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}
