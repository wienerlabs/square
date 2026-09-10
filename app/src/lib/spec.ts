import { specHash, specMatchesDescription } from "@squaresdk/core";
import type { Hex } from "viem";

export type SpecCheck =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "match" }
  | { kind: "mismatch"; hash: Hex };

export function checkSpec(source: string, description: string): SpecCheck {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message.replace(/^JSON\.parse: /, "") : "Invalid JSON" };
  }
  if (specMatchesDescription(value, description)) return { kind: "match" };
  return { kind: "mismatch", hash: specHash(value) };
}
