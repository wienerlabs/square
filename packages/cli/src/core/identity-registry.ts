import { parseEventLogs, zeroAddress, type Address, type Log } from "viem";
import { ValidationError } from "./errors.js";

/**
 * The slice of ERC-8004's IdentityRegistry this CLI writes to.
 *
 * `register` is overloaded in the standard and both forms are present in the
 * deployed implementation behind 0x8004A818… on Arc Testnet (selectors
 * 0x1aa3a008 and 0xf2c298be). They are kept in separate ABI constants rather
 * than one overloaded entry so that neither viem nor TypeScript has to pick
 * between them by arity.
 */
export const REGISTER_WITH_URI_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
] as const;

export const REGISTER_BARE_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
] as const;

export const IDENTITY_READ_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** ERC-721. The registry is an ERC-721, so a mint is a Transfer from the zero address. */
export const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

/**
 * The agent id a registration actually minted, read from the receipt.
 *
 * Taking it from the event rather than from the simulated return value is the
 * whole point: `register` is permissionless, so between simulating and mining
 * someone else's registration can take the id the simulation predicted. The
 * receipt is the only account of what happened.
 *
 * Pure so it can be tested against a fixture receipt without a chain.
 */
export function mintedAgentId(args: {
  logs: Log[];
  registry: Address | string;
  owner: Address | string;
}): bigint {
  const registry = args.registry.toLowerCase();
  const owner = args.owner.toLowerCase();

  const parsed = parseEventLogs({
    abi: TRANSFER_EVENT_ABI,
    eventName: "Transfer",
    logs: args.logs,
  });

  const mints = parsed.filter(
    (l) =>
      l.address.toLowerCase() === registry &&
      l.args.from.toLowerCase() === zeroAddress &&
      l.args.to.toLowerCase() === owner,
  );

  if (mints.length === 0) {
    throw new ValidationError(
      "The transaction was mined but minted no agent to this wallet",
      `No ERC-721 Transfer from the zero address to ${args.owner} was emitted by ${args.registry}.`,
    );
  }
  if (mints.length > 1) {
    throw new ValidationError(
      `The transaction minted ${mints.length} agents; the DID would be ambiguous`,
      `Ids: ${mints.map((m) => m.args.tokenId.toString()).join(", ")}.`,
    );
  }
  // Length is exactly 1, but noUncheckedIndexedAccess does not know that.
  return mints[0]!.args.tokenId;
}
