import canonicalize from "canonicalize";
import { isHex, keccak256, stringToHex, type Hex } from "viem";

export const SPEC_DESCRIPTION_PREFIX = "spec:";

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

export function canonicalSpec(spec: unknown): string {
  if (spec === undefined || typeof spec === "function" || typeof spec === "symbol") {
    throw new SpecError("a spec must be JSON data");
  }
  const canonical = canonicalize(spec);
  if (canonical === undefined) throw new SpecError("a spec must be JSON data");
  return canonical;
}

export function specHash(spec: unknown): Hex {
  return keccak256(stringToHex(canonicalSpec(spec)));
}

export function specDescription(spec: unknown): string {
  return `${SPEC_DESCRIPTION_PREFIX}${specHash(spec)}`;
}

export function specHashFromDescription(description: string): Hex | undefined {
  if (!description.startsWith(SPEC_DESCRIPTION_PREFIX)) return undefined;
  const hash = description.slice(SPEC_DESCRIPTION_PREFIX.length);
  if (!isHex(hash) || hash.length !== 66) return undefined;
  return hash.toLowerCase() as Hex;
}

export function specMatchesDescription(spec: unknown, description: string): boolean {
  return specHashFromDescription(description) === specHash(spec);
}
