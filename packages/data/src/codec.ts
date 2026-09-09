export type Hex = `0x${string}`;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

export function hexToBytes(hex: string): Buffer {
  if (!HEX_BYTES.test(hex)) {
    throw new TypeError(`expected a 0x-prefixed hex string with an even number of digits, got ${JSON.stringify(hex)}`);
  }
  return Buffer.from(hex.slice(2), "hex");
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`;
}

export function nullableHexToBytes(hex: string | null): Buffer | null {
  return hex === null ? null : hexToBytes(hex);
}

export function nullableBytesToHex(bytes: Uint8Array | null): Hex | null {
  return bytes === null ? null : bytesToHex(bytes);
}

export function toBigInt(value: string | number | bigint): bigint {
  return BigInt(value);
}

export function nullableToBigInt(value: string | number | bigint | null): bigint | null {
  return value === null ? null : BigInt(value);
}

export function nullableBigIntParam(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export const NULL_CHARACTER_REPLACEMENT = "\uFFFD";

const NULL_CHARACTER = /\u0000/g;

export function stripNullCharacters<T extends Json>(value: T): T {
  if (typeof value === "string") return value.replace(NULL_CHARACTER, NULL_CHARACTER_REPLACEMENT) as T;
  if (Array.isArray(value)) return value.map((entry) => stripNullCharacters(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key.replace(NULL_CHARACTER, NULL_CHARACTER_REPLACEMENT), stripNullCharacters(entry)]),
    ) as T;
  }
  return value;
}

export function hasNullCharacters(value: Json): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some((entry) => hasNullCharacters(entry));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => key.includes("\u0000") || hasNullCharacters(entry));
  }
  return false;
}

export function jsonParam(value: Json): string {
  return JSON.stringify(stripNullCharacters(value));
}
