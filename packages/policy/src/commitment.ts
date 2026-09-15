import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon8 } from "poseidon-lite/poseidon8";
import { poseidon10 } from "poseidon-lite/poseidon10";
import type { Hex } from "viem";
import { MAX_BLOCKED, MAX_CATEGORIES, MAX_WHITELIST, WEEKDAYS, type Policy } from "./policy.js";

/**
 * The policy commitment, computed the way the circuit and the prover compute
 * it (square#45): eight committed values, each behind a salt derived from the
 * policy's one secret and hashed with its position,
 *
 *   leaf[i] = Poseidon(3)(i, salt[i], value[i])
 *   root    = Poseidon(8)(leaf[0] … leaf[7])
 *
 * and the root is `policy_data_hash`, public signal 1 of every proof and what
 * `PolicyRegistry.commitmentOf(client)` holds. The construction exists in the
 * circuit (circuits/payment.circom), in the prover
 * (services/prover/src/commitment.js and prover.js `buildCircuitInput`) and
 * here, and the three have to agree to the bit; test/commitment.test.ts holds
 * this one to the prover whenever the prover is installed beside it.
 *
 * Nothing here is a secret operation on its own, but the salt goes in, so the
 * function runs where the policy lives: the institution's process or browser.
 * That is why the hash is poseidon-lite rather than circomlibjs: the same
 * Poseidon over BN254 with circomlib's constants, in plain JavaScript, small
 * enough for a page; the cross-check against the prover holds it to
 * circomlibjs's answers.
 */

/** Poseidon over BN254 by arity; the circuit uses 2, 3, 4, 8 and 10 inputs. */
const hash = async (inputs: readonly bigint[]): Promise<bigint> => {
  switch (inputs.length) {
    case 2:
      return poseidon2(inputs as [bigint, bigint]);
    case 3:
      return poseidon3(inputs as [bigint, bigint, bigint]);
    case 4:
      return poseidon4(inputs as [bigint, bigint, bigint, bigint]);
    case 8:
      return poseidon8(inputs as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]);
    case 10:
      return poseidon10(inputs as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]);
    default:
      throw new Error(`no Poseidon of arity ${inputs.length} in the commitment`);
  }
};

/** The committed fields, in the order the circuit hashes them; index i is an input to leaf i. */
export const POLICY_FIELDS = ["max_daily", "max_per_tx", "operator_id", "policy_id", "allowed_categories", "blocked_addresses", "token_whitelist", "time_window"] as const;

export const addressToField = (address: string): bigint => BigInt(`0x${address.trim().toLowerCase().replace(/^0x/, "")}`);

/** 32 bytes as two 16-byte halves, big-endian, the way the prover splits a category and a UUID. */
function halves(bytes: Uint8Array): [bigint, bigint] {
  const padded = new Uint8Array(32);
  padded.set(bytes.subarray(0, 32));
  let high = 0n;
  let low = 0n;
  for (let i = 0; i < 16; i += 1) high = (high << 8n) | BigInt(padded[i]!);
  for (let i = 16; i < 32; i += 1) low = (low << 8n) | BigInt(padded[i]!);
  return [high, low];
}

export async function hashCategory(category: string): Promise<bigint> {
  const utf8 = new TextEncoder().encode(category);
  if (utf8.length === 0 || utf8.length > 32) throw new Error(`category ${JSON.stringify(category)}: 1 to 32 bytes`);
  return hash(halves(utf8));
}

export async function hashUuid(uuid: string): Promise<bigint> {
  const cleaned = uuid.replace(/-/g, "");
  if (cleaned.length !== 32 || !/^[0-9a-f]+$/i.test(cleaned)) throw new Error(`policy_id ${JSON.stringify(uuid)}: not a UUID`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return hash(halves(bytes));
}

const padded = (values: readonly bigint[], length: number): bigint[] => {
  if (values.length > length) throw new Error(`at most ${length} entries, got ${values.length}`);
  return [...values, ...Array.from({ length: length - values.length }, () => 0n)];
};

/** A weekday set as the circuit's bitmask: monday is bit 0. */
export function daysToBitmask(days: readonly string[]): bigint {
  let mask = 0n;
  for (const day of days) {
    const index = WEEKDAYS.indexOf(day.toLowerCase() as (typeof WEEKDAYS)[number]);
    if (index < 0) throw new Error(`${day} is not a weekday`);
    mask |= 1n << BigInt(index);
  }
  return mask;
}

/** The eight leaf salts, `Poseidon(2)(secret, i)`, from the policy's one secret. */
export async function deriveSalts(policySalt: string | bigint): Promise<bigint[]> {
  const secret = BigInt(policySalt);
  const salts: bigint[] = [];
  for (let i = 0; i < POLICY_FIELDS.length; i += 1) salts.push(await hash([secret, BigInt(i)]));
  return salts;
}

/** The eight committed values of a policy, in field order, before salting. */
export async function committedValues(policy: Policy): Promise<bigint[]> {
  const categories = await Promise.all(policy.allowed_endpoint_categories.map((c) => hashCategory(c)));
  const window = policy.time_restrictions?.[0];
  const timeField = window === undefined
    ? 0n
    : await hash([1n, daysToBitmask(window.allowed_days), BigInt(window.allowed_hours_start), BigInt(window.allowed_hours_end)]);
  return [
    BigInt(policy.max_daily_spend),
    BigInt(policy.max_per_transaction),
    addressToField(policy.operator_id),
    await hashUuid(policy.policy_id),
    await hash(padded(categories, MAX_CATEGORIES)),
    await hash(padded(policy.blocked_addresses.map(addressToField), MAX_BLOCKED)),
    await hash(padded(policy.token_whitelist.map(addressToField), MAX_WHITELIST)),
    timeField,
  ];
}

export interface Commitment {
  /** `policy_data_hash`, a field element. */
  root: bigint;
  /** The same, as the bytes32 `setPolicy` takes and `commitmentOf` returns. */
  hex: Hex;
  leaves: bigint[];
}

/** The commitment `PolicyRegistry` should hold for this policy. */
export async function policyCommitment(policy: Policy): Promise<Commitment> {
  const values = await committedValues(policy);
  const salts = await deriveSalts(policy.policy_salt);
  const leaves: bigint[] = [];
  for (let i = 0; i < values.length; i += 1) leaves.push(await hash([BigInt(i), salts[i]!, values[i]!]));
  const root = await hash(leaves);
  return { root, hex: `0x${root.toString(16).padStart(64, "0")}`, leaves };
}

/** A field element as the bytes32 the registry stores. */
export const fieldToHex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
