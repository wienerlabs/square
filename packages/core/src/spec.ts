import canonicalize from "canonicalize";
import { isHex, keccak256, stringToHex, type Hex } from "viem";

export const SPEC_DESCRIPTION_PREFIX = "spec:";

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/**
 * The hash is the job's commitment: `specDescription` goes on chain and any
 * party holding the spec recomputes it, so the canonical text has to be one
 * a JSON parser can read back to a value that canonicalises to the same
 * text. `canonicalize` defines that for JSON data and undertakes nothing for
 * the rest: a nested function came out as `{"f":undefined}`, an `undefined`
 * in an array as `[1,null,undefined]`, both hashed, and a bigint, `NaN`,
 * `Infinity` or a cycle threw a TypeError, an Error or a RangeError where
 * `SpecError` was promised (#298). So JSON data is checked for first, at
 * every depth, and named by path when it is not.
 *
 * JSON data: null, booleans, strings, finite numbers, arrays of it, and
 * plain objects of it. A key whose value is `undefined` is dropped, as
 * `JSON.stringify` drops it. A Date, a Map or a class instance is not JSON
 * data, whatever `toJSON` would have made of it: a commitment is not the
 * place for a silent conversion.
 */
function assertJsonData(value: unknown, path: string, seen: Set<object>): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new SpecError(`a spec must be JSON data: ${path} is ${String(value)}`);
    case "object":
      break;
    default:
      throw new SpecError(`a spec must be JSON data: ${path} is a ${typeof value}`);
  }
  if (value === null) return;
  if (seen.has(value)) throw new SpecError(`a spec must be JSON data: ${path} refers back to itself`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === undefined) throw new SpecError(`a spec must be JSON data: ${path}[${index}] is undefined`);
      assertJsonData(item, `${path}[${index}]`, seen);
    });
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const kind = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new SpecError(`a spec must be JSON data: ${path} is a ${kind}, not a plain object`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      assertJsonData(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function canonicalSpec(spec: unknown): string {
  if (spec === undefined) throw new SpecError("a spec must be JSON data: spec is undefined");
  assertJsonData(spec, "spec", new Set());
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
