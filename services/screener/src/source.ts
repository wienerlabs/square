import { getAddress, isAddress, type Address } from "viem";

/** One source's answer for a batch: what it said about each address, and the exact bytes it said it in. */
export interface SourceAnswer {
  sanctioned: ReadonlyMap<Address, boolean>;
  rawBody: string;
}

export interface ScreeningSource {
  /** Recorded on chain as the record's `source`, so it has to fit in 32 bytes. */
  readonly id: string;
  screen(addresses: readonly Address[]): Promise<SourceAnswer>;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export const TRM_SOURCE_ID = "trm-sanctions-v1";
export const TRM_DEFAULT_BASE_URL = "https://api.trmlabs.com";

/**
 * TRM Labs' sanctions screening API (docs.sanctions.trmlabs.com), called without
 * a key: one request a second, 100 a day. TRM's public documentation names the
 * key's security scheme but not how the key is sent, so no key is sent until TRM
 * says how (docs/decisions/sanctions-screening.md).
 *
 * Anything short of a well-formed answer about every address asked is an error,
 * never a partial result: a source that stayed silent about an address has not
 * cleared it.
 */
export class TrmSanctionsSource implements ScreeningSource {
  readonly id = TRM_SOURCE_ID;

  constructor(
    private readonly baseUrl: string = TRM_DEFAULT_BASE_URL,
    private readonly timeoutMs: number = 10_000,
  ) {}

  async screen(addresses: readonly Address[]): Promise<SourceAnswer> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/public/v1/sanctions/screening`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(addresses.map((address) => ({ address }))),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SourceError(`TRM did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rawBody = await response.text();
    if (response.status !== 200 && response.status !== 201) {
      throw new SourceError(`TRM answered ${response.status}: ${rawBody.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new SourceError("TRM's answer is not JSON");
    }
    if (!Array.isArray(parsed)) throw new SourceError("TRM's answer is not a list");
    const sanctioned = new Map<Address, boolean>();
    for (const entry of parsed) {
      const { address, isSanctioned } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      if (typeof address !== "string" || !isAddress(address, { strict: false }) || typeof isSanctioned !== "boolean") {
        throw new SourceError("TRM's answer has an entry without an address and a boolean isSanctioned");
      }
      sanctioned.set(getAddress(address), isSanctioned);
    }
    for (const address of addresses) {
      if (!sanctioned.has(getAddress(address))) throw new SourceError(`TRM's answer says nothing about ${address}`);
    }
    return { sanctioned, rawBody };
  }
}
