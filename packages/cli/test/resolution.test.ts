import { describe, it, expect } from "vitest";
import type { DidResolutionResult } from "@squaresdk/did-resolver";
import { ExitCode } from "../src/core/errors.js";
import { resolutionError, serializeResolution } from "../src/core/resolution.js";

describe("resolutionError", () => {
  it("maps each resolver error onto a distinguishable exit code", () => {
    // The resolver never throws, so this mapping is the only place a shell can
    // learn what went wrong without parsing English.
    expect(resolutionError("invalidDid", "x").exitCode).toBe(ExitCode.ValidationError);
    expect(resolutionError("notFound", "x").exitCode).toBe(ExitCode.NotFound);
    expect(resolutionError("unsupportedChain", "x").exitCode).toBe(ExitCode.ConfigError);
    expect(resolutionError("registryNotAllowed", "x").exitCode).toBe(ExitCode.ConfigError);
    expect(resolutionError("networkError", "x").exitCode).toBe(ExitCode.NetworkError);
    expect(resolutionError("unsupportedVersion", "x").exitCode).toBe(ExitCode.Generic);
    expect(resolutionError("representationNotSupported", "x").exitCode).toBe(ExitCode.Generic);
  });

  it("keeps a malformed DID separate from a missing one", () => {
    // A v1 DID is well-formed. Reporting it as invalid would tell the caller
    // their identifier is broken when it is merely from the previous method.
    expect(resolutionError("invalidDid", "x").exitCode).not.toBe(
      resolutionError("unsupportedVersion", "x").exitCode,
    );
    expect(resolutionError("notFound", "x").exitCode).not.toBe(
      resolutionError("invalidDid", "x").exitCode,
    );
  });

  it("carries the resolver's message through", () => {
    expect(resolutionError("notFound", "agent 9 does not exist").message).toBe(
      "agent 9 does not exist",
    );
  });

  it("points unsupportedChain at the command that fixes it", () => {
    expect(resolutionError("unsupportedChain", "x").hint).toMatch(/config set-rpc/);
  });
});

describe("serializeResolution", () => {
  it("emits parseable JSON for a successful resolution", () => {
    const result = {
      didDocument: {
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2",
        controller: "did:pkh:eip155:5042002:0x7954350d124Ff904F0D4D89CCEB4499C852C4628",
        verificationMethod: [],
        authentication: [],
        capabilityInvocation: [],
        assertionMethod: [],
        service: [],
      },
      didResolutionMetadata: { contentType: "application/did+ld+json" as const },
      didDocumentMetadata: { versionId: "60751694" },
    } satisfies DidResolutionResult;

    expect(JSON.parse(serializeResolution(result)).didDocument.id).toBe(result.didDocument.id);
  });

  it("survives a bigint, which JSON.stringify would otherwise throw on", () => {
    const withBigint = {
      didDocument: null,
      didResolutionMetadata: { error: "notFound" as const },
      didDocumentMetadata: {},
      // Not part of the type, but a caller extending the result must not crash
      // the whole command over an encoding detail.
      extra: 7n,
    } as unknown as DidResolutionResult;
    expect(JSON.parse(serializeResolution(withBigint)).extra).toBe("7");
  });
});
