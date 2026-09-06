import { defineChain, getAddress, parseUnits, type Address, type Chain } from "viem";
import type { AssetAmount, Network } from "@x402/core/types";

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_NETWORK: Network = "eip155:5042002";
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.io";
export const ARC_TESTNET_USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;
export const USDC_EIP712_DOMAIN = { name: "USDC", version: "2" } as const;
export const USDC_ASSET_TRANSFER_METHOD = "eip3009" as const;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export const arcTestnet: Chain = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC_URL] } },
  testnet: true,
});

export function arcTestnetWithRpc(rpcUrl: string): Chain {
  return defineChain({ ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } });
}

export function usdcAsset(amount: string, asset: Address = ARC_TESTNET_USDC): AssetAmount {
  return {
    asset: getAddress(asset),
    amount: parseUnits(amount, USDC_DECIMALS).toString(),
    extra: {
      name: USDC_EIP712_DOMAIN.name,
      version: USDC_EIP712_DOMAIN.version,
      assetTransferMethod: USDC_ASSET_TRANSFER_METHOD,
    },
  };
}

export function chainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match || match[1] === undefined) {
    throw new Error(`Not an eip155 CAIP-2 network: ${network}`);
  }
  return Number(match[1]);
}

export function networkOf(chainId: number): Network {
  return `eip155:${chainId}`;
}
