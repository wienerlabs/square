import { safeFetch, type SafeFetchOptions } from "@squaresdk/hardening";
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
 * The most of an answer that is read. TRM answered the largest request the
 * screener sends, the canary and MAX_SUBJECTS subjects, in 1,326 bytes. The cap
 * is about fifty times that, room for fields TRM may add, and far short of what
 * an endpoint that is not TRM could otherwise make this process buffer and hash
 * before anything is checked.
 */
export const TRM_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * TRM Labs' sanctions screening API (docs.sanctions.trmlabs.com), called without
 * a key: one request a second, 100 a day. TRM's public documentation names the
 * key's security scheme but not how the key is sent, so no key is sent until TRM
 * says how (docs/decisions/sanctions-screening.md).
 *
 * Anything short of a well-formed answer about every address asked is an error,
 * never a partial result: a source that stayed silent about an address has not
 * cleared it.
 *
 * The request goes through `@squaresdk/hardening`'s `safeFetch`: the base URL
 * must resolve to a public address, the address it resolved to is the one
 * connected to, and the answer is read to `TRM_MAX_RESPONSE_BYTES` and no
 * further. `network` loosens the first check for a test's local endpoint only.
 */
export class TrmSanctionsSource implements ScreeningSource {
  readonly id = TRM_SOURCE_ID;

  constructor(
    private readonly baseUrl: string = TRM_DEFAULT_BASE_URL,
    private readonly timeoutMs: number = 10_000,
    private readonly network: Pick<SafeFetchOptions, "allowPrivate" | "allowedPorts" | "maxResponseBytes"> = {},
  ) {}

  async screen(addresses: readonly Address[]): Promise<SourceAnswer> {
    let response: Response;
    try {
      response = await safeFetch(
        `${this.baseUrl}/public/v1/sanctions/screening`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(addresses.map((address) => ({ address }))),
        },
        { timeoutMs: this.timeoutMs, maxResponseBytes: TRM_MAX_RESPONSE_BYTES, ...this.network },
      );
    } catch (error) {
      throw new SourceError(`TRM did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      throw new SourceError(`TRM's answer could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
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
