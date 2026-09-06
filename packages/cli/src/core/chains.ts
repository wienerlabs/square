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
 */
export const ARC_TESTNET_ID = 5042002;

export interface KnownChain {
  id: number;
  name: string;
  rpcUrl: string;
  /** ERC-8004 IdentityRegistry, lowercase — the form a did:aip v2 string uses. */
  identityRegistry: `0x${string}`;
  explorer?: string;
  /**
   * Arc settles gas in USDC. The native interface reports 18 decimals while the
   * ERC-20 at 0x3600…0000 reports 6; this field is the native one, because it
   * is what a balance from `eth_getBalance` is denominated in.
   * See docs/decisions/erc20-vs-native-usdc.md.
   */
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const KNOWN_CHAINS: Readonly<Record<number, KnownChain>> = {
  [ARC_TESTNET_ID]: {
    id: ARC_TESTNET_ID,
    name: "Arc Testnet",
    rpcUrl: "https://rpc.testnet.arc.io",
    identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
    explorer: "https://testnet.arcscan.app",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  },
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
