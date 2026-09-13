import { concat, encodeAbiParameters, getAddress, isAddress, isHex, keccak256, size, toHex, type Address, type Hex } from "viem";

/**
 * Who a receivable may be sold to. square#30.
 *
 * A sold receivable redirects the poster's money to the buyer, so the poster's
 * policy decides who may buy. The poster publishes one 32-byte root with
 * `PolicyRegistry.setBuyerRoot` and hands each approved buyer its salt and path
 * off chain; the buyer passes both to `ClaimMarket.buy`, which rebuilds the leaf
 * from `msg.sender`. Nothing else about the list reaches the chain.
 *
 * The leaf, the pair hashing and the odd-node rule must match
 * `ClaimMarket.buyerLeaf` and OpenZeppelin's `MerkleProof` exactly. The anvil
 * suites are where that agreement is checked against the chain. The reasoning is
 * in docs/decisions/buyer-eligibility.md.
 */

/** One approved buyer, as the poster keeps it. The salt is the poster's secret. */
export interface BuyerEntry {
  buyer: Address;
  salt: Hex;
}

/** What a buyer passes to `ClaimMarket.buy`. */
export interface BuyerEligibility {
  salt: Hex;
  proof: readonly Hex[];
}

export interface BuyerList {
  /** What `setBuyerRoot` publishes. */
  root: Hex;
  /** Every buyer with its salt, which the poster has to keep to issue paths later. */
  entries: readonly BuyerEntry[];
  eligibilityOf(buyer: Address): BuyerEligibility;
}

export class BuyerListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuyerListError";
  }
}

/**
 * The same floor the prover holds `policy_salt` to (square#178). A leaf hides
 * its buyer only as far as its salt cannot be guessed, and the buyer's address
 * is the half of the preimage anyone can guess.
 */
export const BUYER_SALT_FLOOR = 1n << 128n;

export function buyerLeaf(buyer: Address, salt: Hex): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [buyer, salt])));
}

/** 32 bytes from the platform's CSPRNG, redrawn in the 2^-128 case it lands under the floor. */
export function drawBuyerSalt(): Hex {
  for (;;) {
    const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    if (BigInt(salt) >= BUYER_SALT_FLOOR) return salt;
  }
}

/** A new list: one fresh salt per buyer. Keep `entries`; the salts exist nowhere else. */
export function approveBuyers(buyers: readonly Address[]): BuyerList {
  return buyerListFrom(buyers.map((buyer) => ({ buyer, salt: drawBuyerSalt() })));
}

/** The list rebuilt from entries the poster kept, to issue a path or publish again. */
export function buyerListFrom(entries: readonly BuyerEntry[]): BuyerList {
  if (entries.length === 0) {
    throw new BuyerListError("an empty list has no root; setBuyerRoot(0x00…00) is how a poster approves nobody");
  }
  const seen = new Set<string>();
  const normalised = entries.map(({ buyer, salt }) => {
    if (!isAddress(buyer)) throw new BuyerListError(`${buyer} is not an address`);
    const checksummed = getAddress(buyer);
    if (seen.has(checksummed)) throw new BuyerListError(`${checksummed} is on the list twice`);
    seen.add(checksummed);
    if (!isHex(salt) || size(salt) !== 32) throw new BuyerListError(`the salt for ${checksummed} is not 32 bytes`);
    if (BigInt(salt) < BUYER_SALT_FLOOR) {
      throw new BuyerListError(`the salt for ${checksummed} is below 2^128; draw one with drawBuyerSalt()`);
    }
    return { buyer: checksummed, salt, leaf: buyerLeaf(checksummed, salt) };
  });
  // Sorted by leaf, so the tree says nothing about the order buyers were added in.
  const ordered = [...normalised].sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));
  const levels = levelsOf(ordered.map((entry) => entry.leaf));
  const root = levels[levels.length - 1]![0]!;
  const indexOf = new Map(ordered.map((entry, index) => [entry.buyer, index]));
  const saltOf = new Map(ordered.map((entry) => [entry.buyer, entry.salt]));
  return {
    root,
    entries: normalised.map(({ buyer, salt }) => ({ buyer, salt })),
    eligibilityOf(buyer: Address): BuyerEligibility {
      const key = isAddress(buyer) ? getAddress(buyer) : buyer;
      const index = indexOf.get(key);
      if (index === undefined) throw new BuyerListError(`${buyer} is not on this list`);
      return { salt: saltOf.get(key)!, proof: pathOf(levels, index) };
    },
  };
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function levelsOf(leaves: readonly Hex[]): Hex[][] {
  const levels: Hex[][] = [[...leaves]];
  while (levels[levels.length - 1]!.length > 1) {
    const level = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    levels.push(next);
  }
  return levels;
}

function pathOf(levels: readonly Hex[][], leafIndex: number): Hex[] {
  const path: Hex[] = [];
  let index = leafIndex;
  for (const level of levels.slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) path.push(level[sibling]!);
    index = Math.floor(index / 2);
  }
  return path;
}
