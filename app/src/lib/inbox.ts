import { JobStatus } from "@squaresdk/core";
import { isAddressEqual, zeroAddress, type Address } from "viem";
import type { JobSummary } from "./square";

export type InboxKind = "submit" | "fund" | "budget" | "dispute" | "finalize" | "refund";

export interface InboxGroup {
  kind: InboxKind;
  title: string;
  body: string;
  jobs: JobSummary[];
}

const COPY: Record<InboxKind, { title: string; body: string }> = {
  submit: { title: "Waiting for your deliverable", body: "You are the provider and the escrow is funded. Submit the hash before the expiry." },
  fund: { title: "Waiting for your funding", body: "The budget is agreed. Approve USDC and fund to fix the fees and start the clock." },
  budget: { title: "Needs a budget", body: "You opened these jobs without a budget. Agree one before funding." },
  dispute: { title: "Your challenge window is open", body: "The provider submitted. You may still dispute with a bond until the window closes." },
  finalize: { title: "Ready to finalize", body: "The challenge window closed without a dispute. Anyone may finalize; the payee is credited." },
  refund: { title: "Expired, refund available", body: "Nothing was settled before the expiry and no optimistic evaluator holds the job. Claim the escrow back." },
};

const ORDER: InboxKind[] = ["submit", "fund", "budget", "dispute", "finalize", "refund"];

function same(a: Address, b: Address): boolean {
  return isAddressEqual(a, b);
}

export function classify(job: JobSummary, address: Address, now: number): InboxKind | null {
  const client = same(job.client, address);
  const provider = same(job.provider, address);
  if (!client && !provider) return null;
  const live = now < job.expiredAt;
  switch (job.status) {
    case JobStatus.Open:
      if (!client || !live) return null;
      if (job.budget === 0n) return "budget";
      return same(job.provider, zeroAddress) ? null : "fund";
    case JobStatus.Funded:
      if (!live) return client ? "refund" : null;
      return provider ? "submit" : null;
    case JobStatus.Submitted:
      if (job.disputed) return null;
      if (job.challengeEnd > 0 && now >= job.challengeEnd) return "finalize";
      if (!live) return client && job.challengeEnd === 0 ? "refund" : null;
      return client && job.challengeEnd > 0 ? "dispute" : null;
    default:
      return null;
  }
}

export function walletInbox(jobs: readonly JobSummary[], address: Address | undefined, now: number): InboxGroup[] {
  if (!address) return [];
  const buckets = new Map<InboxKind, JobSummary[]>();
  for (const job of jobs) {
    const kind = classify(job, address, now);
    if (!kind) continue;
    const list = buckets.get(kind) ?? [];
    list.push(job);
    buckets.set(kind, list);
  }
  return ORDER.filter((kind) => buckets.has(kind)).map((kind) => ({ kind, ...COPY[kind], jobs: buckets.get(kind) ?? [] }));
}

export function walletJobCount(jobs: readonly JobSummary[], address: Address | undefined): number {
  if (!address) return 0;
  return jobs.filter((job) => same(job.client, address) || same(job.provider, address)).length;
}
