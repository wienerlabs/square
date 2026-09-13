import { describe, expect, it } from "vitest";
import { concat, keccak256, pad, type Address, type Hex } from "viem";
import {
  approveBuyers,
  BUYER_SALT_FLOOR,
  buyerLeaf,
  buyerListFrom,
  BuyerListError,
  drawBuyerSalt,
  type BuyerEntry,
} from "../src/index.js";

// OpenZeppelin's MerkleProof.processProof, written out here rather than shared
// with src/buyers.ts, so a mistake in the builder cannot also be in the check.
function processProof(proof: readonly Hex[], leaf: Hex): Hex {
  let computed = leaf;
  for (const sibling of proof) {
    computed = BigInt(computed) < BigInt(sibling) ? keccak256(concat([computed, sibling])) : keccak256(concat([sibling, computed]));
  }
  return computed;
}

function addresses(count: number): Address[] {
  return Array.from({ length: count }, () => keccak256(drawBuyerSalt()).slice(0, 42) as Address);
}

describe("buyer lists (square#30)", () => {
  it("hashes a leaf as keccak256(keccak256(abi.encode(buyer, salt)))", () => {
    const [buyer] = addresses(1) as [Address];
    const salt = drawBuyerSalt();
    // abi.encode of (address, bytes32) is the address left-padded to a word, then the salt.
    expect(buyerLeaf(buyer, salt)).toBe(keccak256(keccak256(concat([pad(buyer, { size: 32 }), salt]))));
  });

  it.each([1, 2, 3, 4, 5, 7, 8, 9, 16, 17])("every path in a list of %i reaches the root", (count) => {
    const list = approveBuyers(addresses(count));
    for (const { buyer } of list.entries) {
      const { salt, proof } = list.eligibilityOf(buyer);
      expect(processProof(proof, buyerLeaf(buyer, salt))).toBe(list.root);
    }
  });

  it("a list of one is its own root, with an empty path", () => {
    const list = approveBuyers(addresses(1));
    const [{ buyer, salt }] = list.entries as [BuyerEntry];
    expect(list.root).toBe(buyerLeaf(buyer, salt));
    expect(list.eligibilityOf(buyer).proof).toEqual([]);
  });

  it("a path proves nothing for another address, the check ClaimMarket makes with msg.sender", () => {
    const [mine, theirs] = addresses(2) as [Address, Address];
    const list = approveBuyers([mine, ...addresses(4)]);
    const { salt, proof } = list.eligibilityOf(mine);
    expect(processProof(proof, buyerLeaf(theirs, salt))).not.toBe(list.root);
  });

  it("rebuilds the same root from the entries the poster kept, in any order", () => {
    const list = approveBuyers(addresses(6));
    const reversed = buyerListFrom([...list.entries].reverse());
    expect(reversed.root).toBe(list.root);
    const lowercased = buyerListFrom(list.entries.map(({ buyer, salt }) => ({ buyer: buyer.toLowerCase() as Address, salt })));
    expect(lowercased.root).toBe(list.root);
  });

  it("a fresh list over the same buyers has a different root, because the salts are new", () => {
    const buyers = addresses(3);
    expect(approveBuyers(buyers).root).not.toBe(approveBuyers(buyers).root);
  });

  it("draws 32-byte salts at or above 2^128, and never the same one twice", () => {
    const salts = Array.from({ length: 64 }, drawBuyerSalt);
    for (const salt of salts) {
      expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(salt) >= BUYER_SALT_FLOOR).toBe(true);
    }
    expect(new Set(salts).size).toBe(salts.length);
  });

  it("refuses what would publish a list nobody should trust", () => {
    const [buyer] = addresses(1) as [Address];
    expect(() => buyerListFrom([])).toThrow(BuyerListError);
    expect(() => buyerListFrom([{ buyer: "0x1234" as Address, salt: drawBuyerSalt() }])).toThrow(/not an address/);
    expect(() =>
      buyerListFrom([
        { buyer, salt: drawBuyerSalt() },
        { buyer: buyer.toLowerCase() as Address, salt: drawBuyerSalt() },
      ]),
    ).toThrow(/twice/);
    expect(() => buyerListFrom([{ buyer, salt: "0x01" }])).toThrow(/not 32 bytes/);
    const low = pad(`0x${(BUYER_SALT_FLOOR - 1n).toString(16)}`, { size: 32 });
    expect(() => buyerListFrom([{ buyer, salt: low }])).toThrow(/below 2\^128/);
    expect(() => approveBuyers([buyer]).eligibilityOf(addresses(1)[0]!)).toThrow(/not on this list/);
  });
});
