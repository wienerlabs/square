import { describe, expect, it } from "vitest";
import {
  decodeCompleteOptParams,
  decodeSubmitOptParams,
  encodeCompleteOptParams,
  encodeSubmitOptParams,
  finalizeReason,
  FULL_BPS,
  hashDeliverable,
  Outcome,
  resolutionHash,
  ZERO_HASH,
} from "../src/index.js";

const ones = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const twos = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

describe("submit optParams", () => {
  it("matches abi.encode(uint256 agentId, bytes32 requestHash) as cast produces it", () => {
    expect(encodeSubmitOptParams({ agentId: 892271n, validationRequestHash: ones })).toBe(
      "0x00000000000000000000000000000000000000000000000000000000000d9d6f" + ones.slice(2),
    );
  });

  it("defaults the request hash to zero and round trips", () => {
    const encoded = encodeSubmitOptParams({ agentId: 7n });
    expect(decodeSubmitOptParams(encoded)).toEqual({ agentId: 7n, validationRequestHash: ZERO_HASH });
  });
});

describe("complete optParams", () => {
  it("matches abi.encode(uint16 providerBps, bytes proof) as cast produces it", () => {
    expect(encodeCompleteOptParams({ providerBps: 10_000, complianceProof: "0xdeadbeef" })).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000002710" +
        "0000000000000000000000000000000000000000000000000000000000000040" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "deadbeef00000000000000000000000000000000000000000000000000000000",
    );
  });

  it("defaults to the full share and an empty proof", () => {
    expect(decodeCompleteOptParams(encodeCompleteOptParams())).toEqual({ providerBps: FULL_BPS, complianceProof: "0x" });
    expect(decodeCompleteOptParams("0x")).toEqual({ providerBps: FULL_BPS, complianceProof: "0x" });
  });

  it("rejects an out of range split", () => {
    expect(() => encodeCompleteOptParams({ providerBps: 10_001 })).toThrow(RangeError);
    expect(() => encodeCompleteOptParams({ providerBps: -1 })).toThrow(RangeError);
  });
});

describe("attestation hashes", () => {
  it("finalizeReason matches keccak256(abi.encode('square.finalize.v1', jobId, deliverable))", () => {
    expect(finalizeReason(1n, twos)).toBe("0x70125644223d631c05bd7a2e19ab9eeda882f822a852de25a31cbd87ac4923a4");
  });

  it("resolutionHash matches keccak256(abi.encode('square.resolution.v1', jobId, outcome, bps))", () => {
    expect(resolutionHash(1n, Outcome.Complete, 4_000)).toBe(
      "0x1760a13c3423178984a5adc7e502119d9a8d8c64b50a5a448724c67eea4204d3",
    );
  });

  it("hashDeliverable is keccak256 of the content bytes", () => {
    expect(hashDeliverable("hello")).toBe("0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
    expect(hashDeliverable(new TextEncoder().encode("hello"))).toBe(hashDeliverable("hello"));
  });
});
