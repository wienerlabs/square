/**
 * Maps a resolution result onto the wire format and status codes the DIF
 * Universal Resolver expects.
 *
 * Kept separate from server.ts because it is pure — no Express, no network — so
 * the mapping can be tested on its own. That separation is inherited from the
 * v1 driver and was worth keeping.
 *
 * The resolver never throws and reports failure in `didResolutionMetadata.error`,
 * so nothing here uses try/catch for resolution outcomes; it branches on that
 * field.
 */
import type { DidResolutionResult } from "@squaresdk/did-resolver";

export const DID_RESOLUTION_CONTEXT = "https://w3id.org/did-resolution/v1";
export const DID_LD_JSON = "application/did+ld+json";

export interface ResolutionEnvelope {
  "@context": string;
  didDocument: DidResolutionResult["didDocument"];
  didResolutionMetadata: DidResolutionResult["didResolutionMetadata"];
  didDocumentMetadata: DidResolutionResult["didDocumentMetadata"];
}

/**
 * Resolver error → HTTP status.
 *
 * The Universal Resolver documents 400, 404, 406, 500 and 501. v2 adds error
 * codes the v1 driver never saw, and each maps to the closest documented code
 * rather than collapsing into 500 — a caller that gets 500 retries, and three of
 * these are not worth retrying.
 */
export function statusFor(result: DidResolutionResult): number {
  const error = result.didResolutionMetadata.error;
  if (!error) return 200;
  switch (error) {
    case "invalidDid":
      return 400;
    case "notFound":
      return 404;
    case "representationNotSupported":
      return 406;
    // Well-formed, but this deployment does not serve it: a different resolver
    // might. 501 is what the Universal Resolver uses for "method not supported"
    // and is the nearest honest answer.
    case "unsupportedVersion":
    case "unsupportedChain":
      return 501;
    // We declined to look. Not 404: the agent may well exist.
    case "registryNotAllowed":
      return 403;
    // The fault is upstream, at the RPC. 502 tells a caller retrying is sane;
    // 500 would suggest the driver itself is broken.
    case "networkError":
      return 502;
    default:
      return 500;
  }
}

/**
 * Wrap a result as a DID Resolution Result body.
 *
 * On an error result `didDocumentMetadata` is forced to `{}`. Metadata about a
 * document that was not returned is noise at best and contradictory at worst.
 */
export function toEnvelope(result: DidResolutionResult): ResolutionEnvelope {
  const isError = result.didResolutionMetadata.error !== undefined;
  return {
    "@context": DID_RESOLUTION_CONTEXT,
    didDocument: result.didDocument,
    didResolutionMetadata: result.didResolutionMetadata,
    didDocumentMetadata: isError ? {} : result.didDocumentMetadata,
  };
}

/** For faults outside the resolver — it is not supposed to throw, but if it does. */
export function errorEnvelope(error: string, errorMessage?: string): ResolutionEnvelope {
  return {
    "@context": DID_RESOLUTION_CONTEXT,
    didDocument: null,
    didResolutionMetadata: {
      error: error as never,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
    didDocumentMetadata: {},
  };
}
