import type { BuyerEligibility } from "@squaresdk/core";
import { getAddress, isAddress, type Address, type Hex } from "viem";

// square#30: a receivable sells only to a buyer on its poster's list. The poster
// issues each buyer its salt and path off chain; this reads what the buyer
// pastes back, before anything is sent.

export const ELIGIBILITY_FORMAT_MESSAGE = 'Paste the entry the poster issued you: {"salt": "0x…", "proof": ["0x…", …]}.';

export type EligibilityInput =
  | { kind: "empty" }
  | { kind: "valid"; eligibility: BuyerEligibility; buyer: Address | undefined }
  | { kind: "malformed"; message: string };

const WORD = /^0x[0-9a-fA-F]{64}$/;

function isWord(value: unknown): value is Hex {
  return typeof value === "string" && WORD.test(value);
}

export function readEligibilityInput(value: string): EligibilityInput {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "malformed", message: ELIGIBILITY_FORMAT_MESSAGE };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", message: ELIGIBILITY_FORMAT_MESSAGE };
  }
  const { salt, proof, buyer } = parsed as Record<string, unknown>;
  if (!isWord(salt)) return { kind: "malformed", message: "salt has to be 32 bytes: 0x and 64 hex characters." };
  if (!Array.isArray(proof) || !proof.every(isWord)) {
    return { kind: "malformed", message: "proof has to be a list of 32-byte hex values. A list of one buyer has an empty proof, []." };
  }
  if (buyer !== undefined && (typeof buyer !== "string" || !isAddress(buyer, { strict: false }))) {
    return { kind: "malformed", message: "buyer, when present, has to be a 0x address." };
  }
  return {
    kind: "valid",
    eligibility: { salt, proof },
    buyer: buyer === undefined ? undefined : getAddress(buyer as string),
  };
}
