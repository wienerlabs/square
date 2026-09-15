import type { Address } from "viem";

/**
 * Where an address stands with the hook's sanctions screening (square#35,
 * docs/decisions/sanctions-screening.md), as the registry answers it:
 *
 * - `no-screening`: the hook holds no registry; nobody is screened.
 * - `cleared`: a record exists, is not sanctioned, and is younger than the
 *   registry's `maxAge`. The hook lets this address fund and be paid.
 * - `sanctioned`: a fresh record from a registered screener says the address
 *   is designated. Screening it again changes nothing; the hook refuses it.
 * - `unscreened`: no record, a record past `maxAge`, or one whose screener has
 *   since been revoked. The hook refuses it too, but a fresh screening would
 *   clear it, which is the difference that decides whether to ask for one.
 */
export type ScreeningState = "no-screening" | "cleared" | "sanctioned" | "unscreened";

export interface ScreeningVerdict {
  subject: Address;
  state: ScreeningState;
  /** The registry the verdict was read from; null when the hook screens nobody. */
  registry: Address | null;
}

/**
 * Something that screens addresses and puts the answers on chain: the
 * screener service (services/screener) behind `POST /screen`, or a test's
 * stand-in. `screen` resolves once the records are on chain, so a registry
 * read after it sees them; the service answers only after its submission's
 * receipt. What it answered is not trusted here: the registry is read back
 * and decides.
 */
export interface Screener {
  screen(subjects: readonly Address[]): Promise<void>;
}

/** The party of a job the hook screens before funding, in the order it checks them. */
export type ScreenedRole = "client" | "provider";

/**
 * `fund` was not sent, because the hook would have refused it: one of the
 * job's parties has no fresh, clean screening record (square#368). The job
 * stays where it was, `Open` with its budget set, and the client keeps its
 * money; `state` says whether a screening could still clear the party.
 */
export class PartyNotClearedError extends Error {
  constructor(
    readonly jobId: bigint,
    readonly role: ScreenedRole,
    readonly subject: Address,
    readonly state: Exclude<ScreeningState, "cleared" | "no-screening">,
    readonly detail: string,
  ) {
    super(`the ${role} ${subject} is not cleared to fund job ${jobId}: ${detail}; nothing was sent`);
    this.name = "PartyNotClearedError";
  }
}

export class ScreenerError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "ScreenerError";
  }
}

export interface ScreenerClientOptions {
  /** The screener service's origin, `http://127.0.0.1:3012` for a local one. */
  url: string;
  fetch?: typeof globalThis.fetch | undefined;
  /** A screening is the source's answer plus one confirmation; the default allows a slow chain half a minute. */
  timeoutMs?: number | undefined;
}

/**
 * Addresses per request to the screener: its `MAX_SUBJECTS`
 * (services/screener/src/screen.ts). Each request carries the canary as well,
 * and the source refuses one past the canary and sixteen addresses.
 */
export const SCREENER_MAX_SUBJECTS = 16;

/**
 * `POST /screen` at the screener service (services/screener), the same call
 * the keeper makes before it finalizes (services/keeper/src/screening.ts).
 * The service asks its source, signs what it answered, submits the records
 * and answers after the receipt; a refusal (its canary not flagged, the
 * source down, a malformed request) is an error here, and nothing was
 * attested. The URL is the caller's to give, as the prover's is.
 */
export function createScreenerClient(options: ScreenerClientOptions): Screener {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const screenBatch = async (addresses: readonly Address[]): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ScreenerError(`the screener at ${base} did not answer within ${timeoutMs} ms`, undefined)), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/screen`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ addresses }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof ScreenerError) throw controller.signal.reason;
        throw new ScreenerError(`the screener at ${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`, undefined);
      }
      const text = await response.text();
      if (!response.ok) {
        let reason = text.slice(0, 200);
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === "string") reason = body.error;
        } catch {
          // The status is the answer; the body is whatever it is.
        }
        throw new ScreenerError(`the screener refused the request (${response.status}): ${reason}`, response.status);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async screen(subjects) {
      for (let start = 0; start < subjects.length; start += SCREENER_MAX_SUBJECTS) {
        await screenBatch(subjects.slice(start, start + SCREENER_MAX_SUBJECTS));
      }
    },
  };
}
