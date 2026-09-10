export const FULL_BPS = 10_000n;
export const NATIVE_TO_USDC_DIVISOR = 1_000_000_000_000n;

export interface KeeperCandidate {
  jobId: bigint;
  status: number;
  disputed: boolean;
  challengeEnd: bigint | null;
  budget: bigint;
  evaluatorFeeBP: number | null;
  decidedOutcome?: number | null;
  disputeClosed?: boolean;
  resolveBy?: bigint | null;
  expiredAt?: bigint | null;
}

export const EXPIRY_WARNING_SECONDS = 86_400n;

export interface KeeperEconomics {
  gasPriceWei: bigint;
  finalizeGas: bigint;
  finalizeDecidedGas: bigint;
  minimumMarginBps: number;
}

export type KeeperAction =
  | { kind: "finalize"; jobId: bigint; fee: bigint; gasCost: bigint }
  | { kind: "finalizeDecided"; jobId: bigint; fee: bigint; gasCost: bigint }
  | { kind: "lapse"; jobId: bigint; resolveBy: bigint }
  | { kind: "skip"; jobId: bigint; reason: "windowOpen" | "disputed" | "unprofitable" | "notSubmitted" | "awaitingDecision" };

export function expiryIsNear(candidate: Pick<KeeperCandidate, "expiredAt">, now: bigint): boolean {
  const expiredAt = candidate.expiredAt ?? null;
  if (expiredAt === null) return false;
  const left = expiredAt - now;
  return left > 0n && left <= EXPIRY_WARNING_SECONDS;
}

export function keeperFee(budget: bigint, evaluatorFeeBP: number): bigint {
  return (budget * BigInt(evaluatorFeeBP)) / FULL_BPS;
}

export function gasCostInUsdc(gasPriceWei: bigint, gas: bigint): bigint {
  return (gasPriceWei * gas) / NATIVE_TO_USDC_DIVISOR;
}

export function minimumProfitableBudget(evaluatorFeeBP: number, gasPriceWei: bigint, gas: bigint, marginBps = 0): bigint | null {
  if (evaluatorFeeBP <= 0) return null;
  const cost = gasCostInUsdc(gasPriceWei, gas);
  const required = (cost * (FULL_BPS + BigInt(marginBps))) / FULL_BPS;
  const budget = (required * FULL_BPS) / BigInt(evaluatorFeeBP);
  return budget * BigInt(evaluatorFeeBP) < required * FULL_BPS ? budget + 1n : budget;
}

function profitable(fee: bigint, gasCost: bigint, marginBps: number): boolean {
  return fee * FULL_BPS >= gasCost * (FULL_BPS + BigInt(marginBps));
}

export function decide(candidate: KeeperCandidate, now: bigint, economics: KeeperEconomics): KeeperAction {
  const { jobId } = candidate;
  if (candidate.status !== 2) return { kind: "skip", jobId, reason: "notSubmitted" };
  const fee = keeperFee(candidate.budget, candidate.evaluatorFeeBP ?? 0);
  if (candidate.disputed) {
    const outcome = candidate.decidedOutcome ?? null;
    if (outcome === null || outcome === 0) {
      const resolveBy = candidate.resolveBy ?? null;
      if (resolveBy !== null && now >= resolveBy) return { kind: "lapse", jobId, resolveBy };
      return { kind: "skip", jobId, reason: "awaitingDecision" };
    }
    if (outcome === 2 || candidate.disputeClosed) return { kind: "skip", jobId, reason: "disputed" };
    const gasCost = gasCostInUsdc(economics.gasPriceWei, economics.finalizeDecidedGas);
    if (!profitable(fee, gasCost, economics.minimumMarginBps)) return { kind: "skip", jobId, reason: "unprofitable" };
    return { kind: "finalizeDecided", jobId, fee, gasCost };
  }
  if (candidate.challengeEnd === null || now < candidate.challengeEnd) return { kind: "skip", jobId, reason: "windowOpen" };
  const gasCost = gasCostInUsdc(economics.gasPriceWei, economics.finalizeGas);
  if (!profitable(fee, gasCost, economics.minimumMarginBps)) return { kind: "skip", jobId, reason: "unprofitable" };
  return { kind: "finalize", jobId, fee, gasCost };
}

export function decideAll(candidates: KeeperCandidate[], now: bigint, economics: KeeperEconomics): KeeperAction[] {
  return candidates.map((candidate) => decide(candidate, now, economics));
}

export function oldestPendingAge(candidates: KeeperCandidate[], now: bigint): bigint {
  let oldest = 0n;
  for (const candidate of candidates) {
    if (candidate.status !== 2 || candidate.disputed || candidate.challengeEnd === null) continue;
    if (now < candidate.challengeEnd) continue;
    const age = now - candidate.challengeEnd;
    if (age > oldest) oldest = age;
  }
  return oldest;
}
