import { JobStatus } from "@squaresdk/core";
import { isAddressEqual, type Address } from "viem";

export interface EvaluatedJob {
  evaluator: Address;
}

export interface RefundableJob extends EvaluatedJob {
  status: number;
  expiredAt: number;
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

export function minimumExpiry(now: number, settlementHorizon: number): ExpiryFloor {
  const margin = settlementHorizon;
  return { at: now + settlementHorizon + margin, horizon: settlementHorizon, margin };
}
