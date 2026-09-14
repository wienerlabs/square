import { getAddress, isAddress, type Address } from "viem";

/**
 * A spending policy, in the prover's own vocabulary.
 *
 * These are the policy fields of `POST /prove` (services/prover/src/openapi.js,
 * `ProveRequest`) and nothing else, so a policy file is the request's policy
 * half verbatim and the eight values the commitment covers are named here the
 * way the circuit names them. Amounts are USDC atomic units as decimal
 * strings, because the file is JSON and the numbers do not all fit a double.
 *
 * `policy_salt` is the secret. Every leaf salt derives from it, so whoever
 * holds it can open all eight committed values, two of which (the ceilings)
 * are round USDC amounts a dictionary finds in seconds. It stays with the
 * institution: in the policy file, in the prover's request, nowhere else.
 */
export interface Policy {
  /** A UUID; hashed into the commitment, so it is part of what is committed. */
  policy_id: string;
  /** The secret the eight leaf salts derive from: a decimal field element of at least 2^128. */
  policy_salt: string;
  /** The institution's address. */
  operator_id: Address;
  /** The day's ceiling, USDC atomic units. Also what `setPolicy` publishes as the daily limit. */
  max_daily_spend: string;
  /** The ceiling per release, USDC atomic units. */
  max_per_transaction: string;
  /** The capabilities this policy pays for; a release names one. At most eight, 32 bytes each. */
  allowed_endpoint_categories: string[];
  /** Payees the policy refuses. At most ten. */
  blocked_addresses: Address[];
  /** Tokens the policy pays in. At most ten; on Square this is the chain's USDC. */
  token_whitelist: Address[];
  /** One window, or none. */
  time_restrictions?: [TimeRestriction];
}

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface TimeRestriction {
  allowed_days: Weekday[];
  /** UTC hour, 0 to 23. */
  allowed_hours_start: number;
  /** UTC hour, 0 to 23. */
  allowed_hours_end: number;
}

export const WEEKDAYS: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The circuit's list sizes; a longer list has no witness. */
export const MAX_CATEGORIES = 8;
export const MAX_BLOCKED = 10;
export const MAX_WHITELIST = 10;
/** A category is hashed from 32 bytes; longer ones do not fit. */
export const MAX_CATEGORY_BYTES = 32;

/** BN254's scalar field: every committed value and every salt is an element of it. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** The floor the prover applies to the policy salt (square#178); below it the secret is guessable. */
export const MIN_POLICY_SALT = 1n << 128n;
const UINT64 = 1n << 64n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^(0|[1-9][0-9]*)$/;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * A fresh policy salt: 32 random bytes read as a big-endian integer and
 * reduced into the scalar field, which is all the prover's
 * `randomPolicySalt()` does. Drawn here, never copied from anywhere: a salt
 * that appeared in an example is in every attacker's guess list.
 */
export function randomPolicySalt(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const salt = value % BN254_R;
  // 2^128 is the floor the prover refuses under; a random 256-bit value is
  // under it with probability 2^-128, so this loop is a statement, not a path.
  return salt < MIN_POLICY_SALT ? randomPolicySalt() : salt.toString();
}

export interface NewPolicyOptions {
  operator: Address;
  /** USDC atomic units. */
  maxDailySpend: bigint;
  /** USDC atomic units. */
  maxPerTransaction: bigint;
  categories: readonly string[];
  tokens: readonly Address[];
  blocked?: readonly Address[] | undefined;
  timeRestriction?: TimeRestriction | undefined;
  /** For a policy that must reproduce an existing commitment; drawn fresh otherwise. */
  salt?: string | undefined;
  policyId?: string | undefined;
}

/** A policy with a fresh id and salt, validated the way the prover will validate it. */
export function newPolicy(options: NewPolicyOptions): Policy {
  return parsePolicy({
    policy_id: options.policyId ?? globalThis.crypto.randomUUID(),
    policy_salt: options.salt ?? randomPolicySalt(),
    operator_id: options.operator,
    max_daily_spend: options.maxDailySpend.toString(),
    max_per_transaction: options.maxPerTransaction.toString(),
    allowed_endpoint_categories: [...options.categories],
    blocked_addresses: [...(options.blocked ?? [])],
    token_whitelist: [...options.tokens],
    ...(options.timeRestriction ? { time_restrictions: [options.timeRestriction] } : {}),
  });
}

function field(value: unknown, label: string, max = BN254_R): string {
  const text = typeof value === "bigint" ? value.toString() : typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (text === null || !INTEGER.test(text)) throw new PolicyError(`${label}: must be a non-negative integer`);
  if (BigInt(text) >= max) throw new PolicyError(`${label}: does not fit in ${max === BN254_R ? "the BN254 scalar field" : "64 bits"}`);
  return text;
}

function addresses(value: unknown, label: string, max: number): Address[] {
  if (!Array.isArray(value)) throw new PolicyError(`${label}: must be an array`);
  if (value.length > max) throw new PolicyError(`${label}: at most ${max} entries, got ${value.length}`);
  return value.map((entry, i) => {
    if (typeof entry !== "string" || !isAddress(entry)) throw new PolicyError(`${label}[${i}]: must be a 20-byte hex address`);
    return getAddress(entry);
  });
}

function hour(value: unknown, label: string): number {
  const text = field(value, label);
  const parsed = Number(text);
  if (parsed > 23) throw new PolicyError(`${label}: must be an hour of the day, 0 to 23`);
  return parsed;
}

/**
 * Read a policy from JSON, refusing what the prover would refuse
 * (services/prover/src/prover.js `validateRequest`), so a file that passes
 * here is one `POST /prove` accepts. Addresses come back checksummed.
 */
export function parsePolicy(json: unknown): Policy {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new PolicyError("policy: must be an object");
  const raw = json as Record<string, unknown>;
  for (const key of ["policy_id", "policy_salt", "operator_id", "max_daily_spend", "max_per_transaction", "allowed_endpoint_categories", "blocked_addresses", "token_whitelist"]) {
    if (raw[key] === undefined || raw[key] === null) throw new PolicyError(`${key}: missing`);
  }
  const policyId = raw["policy_id"];
  if (typeof policyId !== "string" || !UUID.test(policyId)) throw new PolicyError("policy_id: not a valid UUID");
  const salt = field(raw["policy_salt"], "policy_salt");
  if (BigInt(salt) < MIN_POLICY_SALT) throw new PolicyError("policy_salt: must be at least 2^128; draw 32 random bytes and reduce them into the field");
  const operator = raw["operator_id"];
  if (typeof operator !== "string" || !isAddress(operator)) throw new PolicyError("operator_id: must be a 20-byte hex address");
  const categories = raw["allowed_endpoint_categories"];
  if (!Array.isArray(categories)) throw new PolicyError("allowed_endpoint_categories: must be an array");
  if (categories.length > MAX_CATEGORIES) throw new PolicyError(`allowed_endpoint_categories: at most ${MAX_CATEGORIES} entries, got ${categories.length}`);
  for (const [i, category] of categories.entries()) {
    if (typeof category !== "string" || category.length === 0) throw new PolicyError(`allowed_endpoint_categories[${i}]: must be a non-empty string`);
    if (new TextEncoder().encode(category).length > MAX_CATEGORY_BYTES) throw new PolicyError(`allowed_endpoint_categories[${i}]: exceeds ${MAX_CATEGORY_BYTES} bytes`);
  }
  const policy: Policy = {
    policy_id: policyId.toLowerCase(),
    policy_salt: salt,
    operator_id: getAddress(operator),
    max_daily_spend: field(raw["max_daily_spend"], "max_daily_spend", UINT64),
    max_per_transaction: field(raw["max_per_transaction"], "max_per_transaction", UINT64),
    allowed_endpoint_categories: categories as string[],
    blocked_addresses: addresses(raw["blocked_addresses"], "blocked_addresses", MAX_BLOCKED),
    token_whitelist: addresses(raw["token_whitelist"], "token_whitelist", MAX_WHITELIST),
  };
  const restrictions = raw["time_restrictions"];
  if (restrictions !== undefined && restrictions !== null) {
    if (!Array.isArray(restrictions) || restrictions.length !== 1) {
      throw new PolicyError("time_restrictions: exactly one window, or leave the field out");
    }
    const window = restrictions[0] as Record<string, unknown>;
    if (typeof window !== "object" || window === null) throw new PolicyError("time_restrictions[0]: must be an object");
    const days = window["allowed_days"];
    if (!Array.isArray(days) || days.length === 0) throw new PolicyError("time_restrictions[0].allowed_days: at least one weekday");
    const named = days.map((day) => {
      const lower = String(day).toLowerCase();
      if (!WEEKDAYS.includes(lower as Weekday)) throw new PolicyError(`time_restrictions[0].allowed_days: ${String(day)} is not a weekday`);
      return lower as Weekday;
    });
    policy.time_restrictions = [
      {
        allowed_days: named,
        allowed_hours_start: hour(window["allowed_hours_start"], "time_restrictions[0].allowed_hours_start"),
        allowed_hours_end: hour(window["allowed_hours_end"], "time_restrictions[0].allowed_hours_end"),
      },
    ];
  }
  return policy;
}

/** The policy as JSON text, the shape `parsePolicy` reads and the prover accepts. */
export function policyToJson(policy: Policy): string {
  return JSON.stringify(policy, null, 2) + "\n";
}

/** The policy with its secret blanked, for logs and screens. */
export function redactPolicy(policy: Policy): Omit<Policy, "policy_salt"> & { policy_salt: "<redacted>" } {
  return { ...policy, policy_salt: "<redacted>" };
}
