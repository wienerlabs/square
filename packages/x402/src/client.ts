import { parseUnits, type Address, type LocalAccount, type TypedDataDefinition } from "viem";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { SpendControls } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, USDC_DECIMALS } from "./network.js";

export interface PayingFetchOptions {
  account: LocalAccount;
  network?: Network;
  rpcUrl?: string;
  asset?: Address;
  maxAmountPerPayment?: string;
  fetch?: typeof globalThis.fetch;
}

export type PayingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function toClientSigner(account: LocalAccount): ClientEvmSigner {
  return {
    address: account.address,
    signTypedData: (message) => account.signTypedData(message as unknown as TypedDataDefinition),
  };
}

export function createPayingClient(options: PayingFetchOptions): x402Client {
  const network = options.network ?? ARC_TESTNET_NETWORK;
  const asset = options.asset ?? ARC_TESTNET_USDC;
  const scheme = new ExactEvmScheme(
    toClientSigner(options.account),
    options.rpcUrl === undefined ? undefined : { rpcUrl: options.rpcUrl }
  );
  const spendControls: SpendControls = {
    maxAmountPerPayment: false,
    allowedAssets: [
      {
        network,
        asset,
        ...(options.maxAmountPerPayment !== undefined
          ? { maxAmountPerPayment: parseUnits(options.maxAmountPerPayment, USDC_DECIMALS).toString() }
          : {}),
      },
    ],
  };
  return new x402Client()
    .register(network, scheme)
    .register("eip155:*", scheme)
    .setSpendControls(spendControls);
}

export function createPayingFetch(options: PayingFetchOptions): PayingFetch {
  const client = createPayingClient(options);
  return wrapFetchWithPayment(options.fetch ?? globalThis.fetch, client);
}
