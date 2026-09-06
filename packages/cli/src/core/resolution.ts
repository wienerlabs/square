import type { DidResolutionResult, ResolutionErrorCode } from "@squaresdk/did-resolver";
import {
  ConfigError,
  SquareError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from "./errors.js";

/**
 * A resolution error, as an exception with an exit code.
 *
 * The resolver never throws — it reports every failure in metadata, because a
 * caller embedding it in agent dispatch must not be taken down by a lookup. A
 * CLI has the opposite obligation: the shell needs a non-zero status, and it
 * needs different ones for "your DID is malformed" and "the RPC is down".
 */
export function resolutionError(code: ResolutionErrorCode, message: string): SquareError {
  switch (code) {
    case "invalidDid":
      return new ValidationError(message, "See docs/did-aip/method-spec-v2.md for the grammar.");
    case "notFound":
      return new NotFoundError(message);
    case "unsupportedChain":
      return new ConfigError(
        message,
        "Add an endpoint for that chain: square config set-rpc <chainId> <url>",
      );
    case "registryNotAllowed":
      return new ConfigError(message);
    case "unsupportedVersion":
      return new SquareError(
        message,
        undefined,
        "did:aip v1 identifiers are Solana-era and are not resolved by this CLI.",
      );
    case "networkError":
      return new NetworkError(message);
    case "representationNotSupported":
      return new SquareError(message);
  }
}

/** JSON.stringify replacer: viem hands back bigints, which JSON cannot encode. */
export function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function serializeResolution(result: DidResolutionResult): string {
  return JSON.stringify(result, jsonSafe, 2);
}
