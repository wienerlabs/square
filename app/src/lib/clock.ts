export const CLOCK_SKEW_NOTICE_SECONDS = 30;

export interface ClockSkew {
  seconds: number;
  ahead: boolean;
}

export function chainClockOffset(chainTimestamp: number, localMs: number): number {
  return chainTimestamp - Math.floor(localMs / 1_000);
}

export function chainNow(offsetSeconds: number, localMs: number): number {
  return Math.floor(localMs / 1_000) + offsetSeconds;
}

export function clockSkew(offsetSeconds: number, threshold = CLOCK_SKEW_NOTICE_SECONDS): ClockSkew | null {
  if (Math.abs(offsetSeconds) < threshold) return null;
  return { seconds: Math.abs(offsetSeconds), ahead: offsetSeconds < 0 };
}
