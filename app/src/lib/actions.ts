import { JobStatus } from "@squaresdk/core";
import { isAddressEqual, type Address } from "viem";

export interface EvaluatedJob {
  evaluator: Address;
}

export interface RefundableJob extends EvaluatedJob {
  status: number;
  expiredAt: number;
}

export interface SubmittableJob {
  status: number;
  expiredAt: number;
  settlementHorizon: number;
}

export interface DisputableJob extends EvaluatedJob {
  status: number;
  challengeEnd: number;
}

export interface ExpiryFloor {
  at: number;
  horizon: number;
  margin: number;
}

export function keeperEvaluates(job: EvaluatedJob, keeperEvaluator: Address): boolean {
  return isAddressEqual(job.evaluator, keeperEvaluator);
}

export function refundAvailable(job: RefundableJob, keeperEvaluator: Address, now: number): boolean {
  if (now < job.expiredAt) return false;
  if (job.status === JobStatus.Funded) return true;
  return job.status === JobStatus.Submitted && !keeperEvaluates(job, keeperEvaluator);
}

export function submitDeadline(job: { expiredAt: number; settlementHorizon: number }): number {
  return job.expiredAt - job.settlementHorizon;
}

export function submitAvailable(job: SubmittableJob, now: number): boolean {
  return job.status === JobStatus.Funded && now < job.expiredAt && now <= submitDeadline(job);
}

export function challengeWindowClosed(challengeEnd: number, now: number): boolean {
  return challengeEnd > 0 && now >= challengeEnd;
}

export function disputeAvailable(job: DisputableJob, keeperEvaluator: Address, now: number): boolean {
  return job.status === JobStatus.Submitted && keeperEvaluates(job, keeperEvaluator) && !challengeWindowClosed(job.challengeEnd, now);
}

export function minimumExpiry(now: number, settlementHorizon: number): ExpiryFloor {
  const margin = settlementHorizon;
  return { at: now + settlementHorizon + margin, horizon: settlementHorizon, margin };
}
