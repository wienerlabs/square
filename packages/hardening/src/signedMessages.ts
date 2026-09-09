import { getAddress, isAddress, recoverTypedDataAddress } from "viem";
import type { Address, Hex, LocalAccount } from "viem";

export { canonicalJson } from "./canonicalJson.js";

export const SQUARE_ACTION_TYPES = {
  SquareAction: [
    { name: "actor", type: "address" },
    { name: "action", type: "string" },
    { name: "resource", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

export const SQUARE_ACTION_PRIMARY_TYPE = "SquareAction";

export interface SquareAction {
  actor: Address;
  action: string;
  resource: string;
  nonce: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  chainId: bigint;
}

export function squareActionDomain(chainId: bigint | number): { name: "Square"; version: "1"; chainId: bigint } {
  return { name: "Square", version: "1", chainId: BigInt(chainId) };
}

export async function signAction(account: LocalAccount, message: SquareAction): Promise<Hex> {
  return account.signTypedData({
    domain: squareActionDomain(message.chainId),
    types: SQUARE_ACTION_TYPES,
    primaryType: SQUARE_ACTION_PRIMARY_TYPE,
    message,
  });
}

export interface NonceStore {
  consume(actor: Address, nonce: bigint, expiresAt: bigint): Promise<boolean>;
}

export function currentUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export interface MemoryNonceStore extends NonceStore {
  prune(): number;
  size(): number;
}

export interface MemoryNonceStoreOptions {
  now?: (() => bigint) | undefined;
  pruneEvery?: number | undefined;
}

export const MEMORY_NONCE_PRUNE_EVERY = 64;

export function memoryNonceStore(options: MemoryNonceStoreOptions = {}): MemoryNonceStore {
  const now = options.now ?? currentUnixSeconds;
  const pruneEvery = Math.max(1, options.pruneEvery ?? MEMORY_NONCE_PRUNE_EVERY);
  const used = new Map<string, Map<bigint, bigint>>();
  let consumedSincePrune = 0;
  const dropExpired = (nonces: Map<bigint, bigint>, current: bigint): void => {
    for (const [seen, expiry] of nonces) if (expiry <= current) nonces.delete(seen);
  };
  const prune = (): number => {
    const current = now();
    let droppedActors = 0;
    for (const [actorKey, nonces] of used) {
      dropExpired(nonces, current);
      if (nonces.size === 0) {
        used.delete(actorKey);
        droppedActors += 1;
      }
    }
    consumedSincePrune = 0;
    return droppedActors;
  };
  return {
    async consume(actor, nonce, expiresAt) {
      consumedSincePrune += 1;
      if (consumedSincePrune >= pruneEvery) prune();
      const actorKey = actor.toLowerCase();
      const nonces = used.get(actorKey) ?? new Map<bigint, bigint>();
      dropExpired(nonces, now());
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, expiresAt);
      used.set(actorKey, nonces);
      return true;
    },
    prune,
    size() {
      return used.size;
    },
  };
}

export type VerifyActionFailure =
  | "malformed_message"
  | "missing_expected_chain_id"
  | "chain_mismatch"
  | "invalid_signature"
  | "actor_mismatch"
  | "unexpected_actor"
  | "not_yet_valid"
  | "expired"
  | "nonce_reused";

export type VerifyActionResult =
  | { ok: true; actor: Address; message: SquareAction }
  | { ok: false; reason: VerifyActionFailure; detail: string };

export interface VerifyActionInput {
  message: SquareAction;
  signature: Hex;
  expectedActor: Address;
  nonceStore: NonceStore;
  expectedChainId: bigint | number;
  now?: bigint | number | undefined;
}

function failure(reason: VerifyActionFailure, detail: string): VerifyActionResult {
  return { ok: false, reason, detail };
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export async function verifyAction(input: VerifyActionInput): Promise<VerifyActionResult> {
  const { message, signature, expectedActor, nonceStore } = input;
  if (!isAddress(message.actor)) return failure("malformed_message", "message.actor is not an address");
  if (!isAddress(expectedActor)) return failure("malformed_message", "expectedActor is not an address");
  if (message.expiresAt <= message.issuedAt) return failure("malformed_message", "expiresAt must be after issuedAt");
  if (input.expectedChainId === undefined || input.expectedChainId === null) {
    return failure(
      "missing_expected_chain_id",
      "expectedChainId is required: without it a signature made for another chain verifies here"
    );
  }
  if (BigInt(input.expectedChainId) !== message.chainId) {
    return failure("chain_mismatch", `message is for chain ${message.chainId}, expected ${input.expectedChainId}`);
  }
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: squareActionDomain(message.chainId),
      types: SQUARE_ACTION_TYPES,
      primaryType: SQUARE_ACTION_PRIMARY_TYPE,
      message,
      signature,
    });
  } catch (error) {
    return failure("invalid_signature", error instanceof Error ? error.message : String(error));
  }
  if (!sameAddress(recovered, message.actor)) {
    return failure("actor_mismatch", `signature recovers to ${recovered} but the message names ${message.actor}`);
  }
  if (!sameAddress(recovered, expectedActor)) {
    return failure("unexpected_actor", `signature recovers to ${recovered} but ${expectedActor} was expected`);
  }
  const now = BigInt(input.now ?? currentUnixSeconds());
  if (now < message.issuedAt) return failure("not_yet_valid", `issuedAt ${message.issuedAt} is after now ${now}`);
  if (now >= message.expiresAt) return failure("expired", `expiresAt ${message.expiresAt} is not after now ${now}`);
  const fresh = await nonceStore.consume(getAddress(message.actor), message.nonce, message.expiresAt);
  if (!fresh) return failure("nonce_reused", `nonce ${message.nonce} was already consumed for ${message.actor}`);
  return { ok: true, actor: getAddress(recovered), message };
}
