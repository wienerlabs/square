import { describe, it, expect } from "vitest";
import { statusFor, toEnvelope, errorEnvelope, DID_RESOLUTION_CONTEXT } from "../src/envelope.js";
import type { DidResolutionResult } from "@squaresdk/did-resolver";

const ok = (): DidResolutionResult => ({
  didDocument: { id: "did:aip:eip155:5042002:0xabc:1" } as never,
  didResolutionMetadata: { contentType: "application/did+ld+json" },
  didDocumentMetadata: { versionId: "42", agentRegistry: "eip155:5042002:0xabc" },
});
const err = (error: string): DidResolutionResult => ({
  didDocument: null,
  didResolutionMetadata: { error: error as never, errorMessage: "…" },
  didDocumentMetadata: { deactivated: true },
});

describe("status mapping", () => {
  it("200 when a document was produced", () => expect(statusFor(ok())).toBe(200));

  it.each([
    ["invalidDid", 400],
    ["notFound", 404],
    ["representationNotSupported", 406],
    ["unsupportedVersion", 501],
    ["unsupportedChain", 501],
    ["registryNotAllowed", 403],
    ["networkError", 502],
    ["somethingNobodyDefined", 500],
  ])("%s → %i", (code, status) => {
    expect(statusFor(err(code))).toBe(status);
  });

  it("keeps the retryable and non-retryable cases apart", () => {
    // A caller that sees 5xx will retry. Only the upstream fault deserves that.
    expect(statusFor(err("networkError"))).toBe(502);
    expect(statusFor(err("unsupportedChain"))).not.toBeGreaterThanOrEqual(502);
    expect(statusFor(err("registryNotAllowed"))).toBeLessThan(500);
  });
});

describe("envelope", () => {
  it("adds the resolution context and keeps the three standard members", () => {
    const e = toEnvelope(ok());
    expect(e["@context"]).toBe(DID_RESOLUTION_CONTEXT);
    expect(Object.keys(e).sort()).toEqual(
      ["@context", "didDocument", "didDocumentMetadata", "didResolutionMetadata"]
    );
    expect(e.didDocumentMetadata.versionId).toBe("42");
  });

  it("drops document metadata on an error", () => {
    // { deactivated: true } for a document that was never returned is noise.
    expect(toEnvelope(err("notFound")).didDocumentMetadata).toEqual({});
  });

  it("serialises — nothing in the result is a BigInt", () => {
    expect(() => JSON.stringify(toEnvelope(ok()))).not.toThrow();
  });

  it("builds an error envelope for faults outside the resolver", () => {
    const e = errorEnvelope("internalError", "boom");
    expect(e.didDocument).toBeNull();
    expect(e.didResolutionMetadata.errorMessage).toBe("boom");
  });
});
