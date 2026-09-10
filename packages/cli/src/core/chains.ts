import { ARC_TESTNET_CHAIN_ID, deploymentFor, networkFor } from "@squaresdk/core";
import { defineChain, type Chain } from "viem";

/**
 * Chains this CLI knows without being told.
 *
 * Only Arc Testnet is listed, and only because every value in it was read off
 * the chain rather than out of a document: `eth_chainId` returns 0x4cef52, and
 * `name()` / `symbol()` on the registry return "AgentIdentity" / "AGENT".
 * ERC-8004 deploys its registries at the same `0x8004…` addresses everywhere,
 * but "everywhere" is a claim about deployments we have not checked, so other
 * chains have to be configured explicitly (`--registry`, or `square config`).
 *
 * None of those values is written here. They are read from `@squaresdk/core`,
 * which is the one place a chain id, an endpoint or an address is declared.
 */
export const ARC_TESTNET_ID = ARC_TESTNET_CHAIN_ID;

export interface KnownChain {
  id: number;
  name: string;
  rpcUrl: string;
  /** ERC-8004 IdentityRegistry, lowercase — the form a did:aip v2 string uses. */
  identityRegistry: `0x${string}`;
  explorer?: string;
  /** The chain's native unit; on Arc that is USDC at 18 decimals, not ether. */
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

function knownChain(chainId: number): KnownChain {
  const network = networkFor(chainId);
  return {
    id: network.chainId,
    name: network.name,
    rpcUrl: network.rpcUrl,
    // did:aip v2 spells the registry in lowercase, so lowercase the one address
    // rather than keeping a second copy of it that could drift from the first.
    identityRegistry: deploymentFor(chainId).identityRegistry.toLowerCase() as `0x${string}`,
    ...(network.explorerUrl ? { explorer: network.explorerUrl } : {}),
    nativeCurrency: network.nativeCurrency,
  };
}

export const KNOWN_CHAINS: Readonly<Record<number, KnownChain>> = {
  [ARC_TESTNET_ID]: knownChain(ARC_TESTNET_ID),
};

export const DEFAULT_CHAIN_ID = ARC_TESTNET_ID;

/** A fully resolved target: chain id, endpoint and registry, however they were supplied. */
export interface Network {
  chainId: number;
  name: string;
  rpcUrl: string;
  identityRegistry: `0x${string}`;
  explorer: string | undefined;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

/** viem needs a Chain object to sign an EIP-155 transaction against. */
export function toViemChain(network: Network): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [network.rpcUrl] } },
    ...(network.explorer
      ? { blockExplorers: { default: { name: "Explorer", url: network.explorer } } }
      : {}),
    testnet: network.chainId === ARC_TESTNET_ID,
  });
}

export function explorerTxUrl(network: Network, hash: string): string | undefined {
  return network.explorer ? `${network.explorer.replace(/\/+$/, "")}/tx/${hash}` : undefined;
}
