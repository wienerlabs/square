import { getAddress, isAddress, type Address } from "viem";

export const ADDRESS_FORMAT_MESSAGE = "Enter a 0x address of 40 hex characters.";

export type AddressInput =
  | { kind: "empty" }
  | { kind: "valid"; address: Address }
  | { kind: "checksum"; suggestion: Address }
  | { kind: "malformed" };

export function readAddressInput(value: string): AddressInput {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const normalized = trimmed.startsWith("0X") ? `0x${trimmed.slice(2)}` : trimmed;
  if (isAddress(normalized)) return { kind: "valid", address: getAddress(normalized) };
  if (!isAddress(normalized, { strict: false })) return { kind: "malformed" };
  return { kind: "checksum", suggestion: getAddress(normalized) };
}

export function addressChecksumMessage(suggestion: Address): string {
  return `Those are 40 hex characters, but the EIP-55 checksum does not match. The checksummed form is ${suggestion}.`;
}

export function addressInputError(input: AddressInput): string | null {
  if (input.kind === "malformed") return ADDRESS_FORMAT_MESSAGE;
  if (input.kind === "checksum") return addressChecksumMessage(input.suggestion);
  return null;
}
