import { ANVIL_CHAIN_ID, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_RPC_URL, deploymentFor } from "@squaresdk/core";
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { createConfig, injected } from "wagmi";

export const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
export const ANVIL_RPC_URL = "http://127.0.0.1:8545";
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const DOCS_URL = "https://github.com/wienerlabs/square/tree/main/docs/design";
export const REPO_URL = "https://github.com/wienerlabs/square";

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC_URL] } },
  blockExplorers: { default: { name: "Arcscan", url: ARC_EXPLORER_URL } },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  testnet: true,
});

export const anvil = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
  testnet: true,
});

function selectedChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const parsed = raw ? Number.parseInt(raw, 10) : ARC_TESTNET_CHAIN_ID;
  return parsed === ANVIL_CHAIN_ID ? ANVIL_CHAIN_ID : ARC_TESTNET_CHAIN_ID;
}

const baseChain: Chain = selectedChainId() === ANVIL_CHAIN_ID ? anvil : arcTestnet;
const rpcOverride = (process.env.NEXT_PUBLIC_RPC_URL ?? "").trim();

export const rpcUrl: string = rpcOverride.length > 0 ? rpcOverride : (baseChain.rpcUrls.default.http[0] ?? ARC_TESTNET_RPC_URL);

export const activeChain: Chain = {
  ...baseChain,
  rpcUrls: { default: { http: [rpcUrl] } },
};

export const explorerUrl: string | null = activeChain.blockExplorers?.default.url ?? null;

export const deployment = deploymentFor(activeChain.id);

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: { [activeChain.id]: http(rpcUrl, { batch: true }) },
});

export const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(rpcUrl, { batch: true }),
  batch: { multicall: true },
});
