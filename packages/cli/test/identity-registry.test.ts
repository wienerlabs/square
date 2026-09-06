import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Log } from "viem";
import { mintedAgentId } from "../src/core/identity-registry.js";

const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const OWNER = "0x7954350d124Ff904F0D4D89CCEB4499C852C4628";
const OTHER = "0xb7ACAC0ffe24A867f86D2DE5e03e98c839A41553";

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

function pad(address: string): `0x${string}` {
  return encodeAbiParameters([{ type: "address" }], [address as `0x${string}`]);
}

/** An ERC-721 Transfer log: from, to and tokenId are all indexed. */
function transferLog(args: {
  address?: string;
  from: string;
  to: string;
  tokenId: bigint;
}): Log {
  return {
    address: (args.address ?? REGISTRY) as `0x${string}`,
    topics: [
      TRANSFER_TOPIC,
      pad(args.from),
      pad(args.to),
      encodeAbiParameters([{ type: "uint256" }], [args.tokenId]),
    ],
    data: "0x",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

describe("mintedAgentId", () => {
  it("reads the id from the mint in the receipt", () => {
    const logs = [transferLog({ from: zeroAddress, to: OWNER, tokenId: 892238n })];
    expect(mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toBe(892238n);
  });

  it("matches the owner case-insensitively", () => {
    const logs = [transferLog({ from: zeroAddress, to: OWNER.toLowerCase(), tokenId: 7n })];
    expect(mintedAgentId({ logs, registry: REGISTRY.toUpperCase(), owner: OWNER })).toBe(7n);
  });

  it("ignores logs from other contracts in the same transaction", () => {
    const logs = [
      transferLog({
        address: "0x0747eef0706327138c69792bf28cd525089e4583",
        from: zeroAddress,
        to: OWNER,
        tokenId: 999n,
      }),
      transferLog({ from: zeroAddress, to: OWNER, tokenId: 12n }),
    ];
    expect(mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toBe(12n);
  });

  it("ignores a plain transfer, which is not a mint", () => {
    // A transfer of an existing agent also emits Transfer. Taking its tokenId
    // would hand back a DID for an agent this transaction did not create.
    const logs = [
      transferLog({ from: OTHER, to: OWNER, tokenId: 3n }),
      transferLog({ from: zeroAddress, to: OWNER, tokenId: 44n }),
    ];
    expect(mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toBe(44n);
  });

  it("ignores a mint to somebody else", () => {
    const logs = [
      transferLog({ from: zeroAddress, to: OTHER, tokenId: 5n }),
      transferLog({ from: zeroAddress, to: OWNER, tokenId: 6n }),
    ];
    expect(mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toBe(6n);
  });

  it("throws when the transaction minted nothing to this wallet", () => {
    const logs = [transferLog({ from: zeroAddress, to: OTHER, tokenId: 5n })];
    expect(() => mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toThrow(
      /minted no agent/,
    );
  });

  it("throws rather than guess when two agents were minted", () => {
    const logs = [
      transferLog({ from: zeroAddress, to: OWNER, tokenId: 1n }),
      transferLog({ from: zeroAddress, to: OWNER, tokenId: 2n }),
    ];
    expect(() => mintedAgentId({ logs, registry: REGISTRY, owner: OWNER })).toThrow(/ambiguous/);
  });

  it("throws on an empty receipt", () => {
    expect(() => mintedAgentId({ logs: [], registry: REGISTRY, owner: OWNER })).toThrow(
      /minted no agent/,
    );
  });
});
