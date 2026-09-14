import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from "viem";

/**
 * The proof bytes a job carries (`SquareJob.setComplianceProof`) and the
 * module reads: the Groth16 proof and the eight public signals, ABI-encoded
 * the way `contracts/script/refusal-scenarios.mjs` encodes them and
 * `ComplianceModule.verifiedSignals` decodes them. 16 words, 512 bytes; the
 * module refuses any other length as malformed.
 */
export const PROOF_ABI = [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256[8]" }] as const;
export const PROOF_BYTES = 16 * 32;

/** The eight public signals, in circuit output order. */
export const SIGNALS = [
  "is_compliant",
  "policy_data_hash",
  "recipient",
  "amount",
  "token",
  "daily_spent_before",
  "current_unix_timestamp",
  "stripe_receipt_hash",
] as const;

export interface SolidityProof {
  a: readonly [string, string];
  b: readonly [readonly [string, string], readonly [string, string]];
  c: readonly [string, string];
  input: readonly string[];
}

export interface ComplianceProof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
  input: readonly bigint[];
}

export interface ProofSignals {
  isCompliant: boolean;
  policyDataHash: bigint;
  recipient: Address;
  amount: bigint;
  token: Address;
  dailySpentBefore: bigint;
  timestamp: bigint;
  stripeReceiptHash: bigint;
}

const big = (value: string | bigint): bigint => BigInt(value);

/** The prover's `solidity` block as the bytes the job carries. */
export function encodeComplianceProof(proof: SolidityProof | ComplianceProof): Hex {
  if (proof.input.length !== 8) throw new Error(`a compliance proof carries 8 public signals, got ${proof.input.length}`);
  return encodeAbiParameters(PROOF_ABI, [
    [big(proof.a[0]), big(proof.a[1])],
    [
      [big(proof.b[0][0]), big(proof.b[0][1])],
      [big(proof.b[1][0]), big(proof.b[1][1])],
    ],
    [big(proof.c[0]), big(proof.c[1])],
    proof.input.map(big) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
  ]);
}

/** The proof a job carries, or null for `0x` and for anything that is not 512 bytes. */
export function decodeComplianceProof(bytes: Hex): ComplianceProof | null {
  if (bytes === "0x" || (bytes.length - 2) / 2 !== PROOF_BYTES) return null;
  try {
    const [a, b, c, input] = decodeAbiParameters(PROOF_ABI, bytes);
    return { a: [a[0], a[1]], b: [[b[0][0], b[0][1]], [b[1][0], b[1][1]]], c: [c[0], c[1]], input: [...input] };
  } catch {
    return null;
  }
}

const address = (value: bigint): Address => `0x${value.toString(16).padStart(40, "0")}` as Address;

/** The eight signals, named. */
export function signalsOf(proof: ComplianceProof): ProofSignals {
  const [isCompliant, policyDataHash, recipient, amount, token, dailySpentBefore, timestamp, stripeReceiptHash] = proof.input as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    isCompliant: isCompliant === 1n,
    policyDataHash,
    recipient: address(recipient),
    amount,
    token: address(token),
    dailySpentBefore,
    timestamp,
    stripeReceiptHash,
  };
}
