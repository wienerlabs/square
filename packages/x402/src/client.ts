import { parseUnits, type Address, type LocalAccount, type TypedDataDefinition } from "viem";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { PaymentPolicy, SpendControls } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, USDC_DECIMALS } from "./network.js";

export interface PayingFetchOptions {
  account: LocalAccount;
  maxAmountPerPayment: string;
  network?: Network;
  rpcUrl?: string;
  asset?: Address;
  fetch?: typeof globalThis.fetch;
}

export type PayingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;
const ATOMIC_AMOUNT = /^\d+$/;

export function toClientSigner(account: LocalAccount): ClientEvmSigner {
  return {
    address: account.address,
    signTypedData: (message) => account.signTypedData(message as unknown as TypedDataDefinition),
  };
}

function atomicCap(maxAmountPerPayment: unknown): bigint {
  if (typeof maxAmountPerPayment !== "string" || !DECIMAL_AMOUNT.test(maxAmountPerPayment)) {
    throw new TypeError(
      `createPayingClient: maxAmountPerPayment is required and must be a decimal USDC string such as "1.00", got ${JSON.stringify(maxAmountPerPayment)}`
    );
  }
  const cap = parseUnits(maxAmountPerPayment, USDC_DECIMALS);
  if (cap <= 0n) {
    throw new RangeError(`createPayingClient: maxAmountPerPayment must be above zero, got ${maxAmountPerPayment}`);
  }
  return cap;
}

function describeOffer(requirement: PaymentRequirements): string {
  return `${requirement.amount} of ${requirement.asset} on ${requirement.network}`;
}

function payableUnder(network: Network, asset: Address, cap: bigint): PaymentPolicy {
  const wanted = asset.toLowerCase();
  return (x402Version, requirements) => {
    if (x402Version !== 2) {
      throw new Error(`createPayingFetch pays x402 v2 only, the resource server offered v${x402Version}`);
    }
    const payable = requirements.filter(
      (requirement) =>
        requirement.network === network &&
        typeof requirement.asset === "string" &&
        requirement.asset.toLowerCase() === wanted &&
        ATOMIC_AMOUNT.test(requirement.amount) &&
        BigInt(requirement.amount) > 0n &&
        BigInt(requirement.amount) <= cap
    );
    if (payable.length === 0) {
      throw new Error(
        `createPayingFetch refused every offer in the 402: this client signs only for ${asset} on ${network}, ` +
          `at most ${cap.toString()} atomic units per payment. Offered: ${requirements.map(describeOffer).join("; ")}`
      );
    }
    return payable;
  };
}

export function createPayingClient(options: PayingFetchOptions): x402Client {
  const network = options.network ?? ARC_TESTNET_NETWORK;
  const asset = options.asset ?? ARC_TESTNET_USDC;
  const cap = atomicCap(options.maxAmountPerPayment);
  const scheme = new ExactEvmScheme(
    toClientSigner(options.account),
    options.rpcUrl === undefined ? undefined : { rpcUrl: options.rpcUrl }
  );
  const spendControls: SpendControls = {
    maxAmountPerPayment: options.maxAmountPerPayment,
    allowedAssets: [{ network, asset, maxAmountPerPayment: cap.toString() }],
  };
  return new x402Client()
    .register(network, scheme)
    .setSpendControls(spendControls)
    .registerPolicy(payableUnder(network, asset, cap));
}

export function createPayingFetch(options: PayingFetchOptions): PayingFetch {
  const client = createPayingClient(options);
  return wrapFetchWithPayment(options.fetch ?? globalThis.fetch, client);
}
