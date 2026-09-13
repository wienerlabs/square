import { setTimeout as delay } from "node:timers/promises";

export async function waitUnlessAborted(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
}
