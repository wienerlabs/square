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

export function memoryNonceStore(options: { now?: (() => bigint) | undefined } = {}): NonceStore {
  const now = options.now ?? currentUnixSeconds;
  const used = new Map<string, Map<bigint, bigint>>();
  return {
    async consume(actor, nonce, expiresAt) {
      const actorKey = actor.toLowerCase();
      const nonces = used.get(actorKey) ?? new Map<bigint, bigint>();
      const current = now();
      for (const [seen, expiry] of nonces) if (expiry <= current) nonces.delete(seen);
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, expiresAt);
      used.set(actorKey, nonces);
      return true;
    },
  };
}

export type VerifyActionFailure =
  | "malformed_message"
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
  now?: bigint | number | undefined;
  expectedChainId?: bigint | number | undefined;
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
  if (input.expectedChainId !== undefined && BigInt(input.expectedChainId) !== message.chainId) {
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
