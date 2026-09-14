import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeComplianceProof, encodeComplianceProof, PROOF_BYTES, signalsOf, type SolidityProof } from "../src/proof.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "test", "fixtures", "proofs.json");
const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, SolidityProof & { is_compliant: boolean }>;

describe("compliance proof bytes", () => {
  it("encodes a prover response to the 512 bytes the module reads, and decodes them back", () => {
    const proof = fixtures["compliant"]!;
    const bytes = encodeComplianceProof(proof);
    expect((bytes.length - 2) / 2).toBe(PROOF_BYTES);
    const decoded = decodeComplianceProof(bytes)!;
    expect(decoded.a.map(String)).toEqual(proof.a.map((v) => BigInt(v).toString()));
    expect(decoded.b.map((row) => row.map(String))).toEqual(proof.b.map((row) => row.map((v) => BigInt(v).toString())));
    expect(decoded.c.map(String)).toEqual(proof.c.map((v) => BigInt(v).toString()));
    expect(decoded.input.map(String)).toEqual(proof.input.map((v) => BigInt(v).toString()));
  });

  it("names the eight signals", () => {
    const signals = signalsOf(decodeComplianceProof(encodeComplianceProof(fixtures["compliant"]!))!);
    expect(signals.isCompliant).toBe(true);
    expect(signals.recipient).toMatch(/^0x[0-9a-f]{40}$/);
    expect(signals.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(signals.stripeReceiptHash).toBe(0n);
    const blocked = signalsOf(decodeComplianceProof(encodeComplianceProof(fixtures["blocked"]!))!);
    expect(blocked.isCompliant).toBe(false);
  });

  it("reads nothing into an empty slot or a proof of the wrong length", () => {
    expect(decodeComplianceProof("0x")).toBeNull();
    expect(decodeComplianceProof(`0x${"00".repeat(511)}`)).toBeNull();
    expect(decodeComplianceProof(`0x${"00".repeat(513)}`)).toBeNull();
  });

  it("refuses to encode a proof without eight signals", () => {
    expect(() => encodeComplianceProof({ ...fixtures["compliant"]!, input: ["1"] })).toThrow(/8 public signals/);
  });
});
