import type { Context } from "hono";

export const TRANSIENT_REJECTION_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

const TRANSIENT_REJECTION_VARIABLE = "squareTransientRejection";

type TransientRejectionEnv = { Variables: { squareTransientRejection: boolean } };

export function markTransientRejection(c: Context): void {
  (c as Context<TransientRejectionEnv>).set(TRANSIENT_REJECTION_VARIABLE, true);
}

export function isTransientRejection(c: Context): boolean {
  return (c as Context<TransientRejectionEnv>).get(TRANSIENT_REJECTION_VARIABLE) === true;
}
