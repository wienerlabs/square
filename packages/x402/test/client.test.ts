import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createPayingClient, createPayingFetch, type PayingFetchOptions } from "../src/client.js";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, usdcAsset } from "../src/network.js";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const payee: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const BASE_NETWORK = "eip155:8453";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "http://gateway.local/quote";

const options: PayingFetchOptions = {
  account: payer,
  network: ARC_TESTNET_NETWORK,
  asset: ARC_TESTNET_USDC,
  maxAmountPerPayment: "1.00",
};

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  const price = usdcAsset("0.05");
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: price.asset,
    amount: price.amount,
    payTo: payee,
    maxTimeoutSeconds: 300,
    extra: { ...price.extra },
    ...overrides,
  };
}

function baseOffer(): PaymentRequirements {
  return requirements({
    network: BASE_NETWORK,
    asset: BASE_USDC,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  });
}

function payFor(accepts: PaymentRequirements[], overrides: Partial<PayingFetchOptions> = {}): Promise<PaymentPayload> {
  return createPayingClient({ ...options, ...overrides }).createPaymentPayload({
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts,
  });
}

describe("createPayingClient", () => {
  it("signs for the configured network and asset", async () => {
    const payload = await payFor([requirements()]);
    expect(payload.accepted?.network).toBe(ARC_TESTNET_NETWORK);
    expect(getAddress(payload.accepted?.asset ?? "0x")).toBe(getAddress(ARC_TESTNET_USDC));
    const authorization = payload.payload["authorization"] as { from: string; value: string };
    expect(getAddress(authorization.from)).toBe(payer.address);
    expect(authorization.value).toBe("50000");
  });

  it("refuses a 402 that names another chain, even for an asset the library knows by default", async () => {
    await expect(payFor([baseOffer()])).rejects.toThrow(/No network\/scheme registered/);
  });

  it("takes the configured chain out of a mixed offer instead of the other one", async () => {
    const payload = await payFor([baseOffer(), requirements()]);
    expect(payload.accepted?.network).toBe(ARC_TESTNET_NETWORK);
  });

  it("refuses an asset it was not configured with, on the configured chain", async () => {
    const other = getAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
    await expect(payFor([requirements({ asset: other })])).rejects.toThrow(/refused every offer|rejected by spendControls/);
  });

  it("refuses an amount above the per-payment cap and pays one exactly at it", async () => {
    const cap = usdcAsset("1.00");
    await expect(payFor([requirements({ amount: (BigInt(cap.amount) + 1n).toString() })])).rejects.toThrow(
      /refused every offer|maxAmountPerPayment/,
    );
    const atCap = await payFor([requirements({ amount: cap.amount })]);
    expect((atCap.payload["authorization"] as { value: string }).value).toBe(cap.amount);
  });

  it("refuses an amount of zero", async () => {
    await expect(payFor([requirements({ amount: "0" })])).rejects.toThrow(/refused every offer/);
  });

  it("refuses a v1 offer", async () => {
    await expect(
      createPayingClient(options).createPaymentPayload({
        x402Version: 1,
        resource: { url: RESOURCE },
        accepts: [requirements()],
      } as never),
    ).rejects.toThrow();
  });

  it("will not build a client that can sign without a cap", () => {
    expect(() => createPayingFetch({ account: payer } as unknown as PayingFetchOptions)).toThrow(TypeError);
    expect(() => createPayingClient({ ...options, maxAmountPerPayment: "" })).toThrow(TypeError);
    expect(() => createPayingClient({ ...options, maxAmountPerPayment: "$1.00" })).toThrow(TypeError);
    expect(() => createPayingClient({ ...options, maxAmountPerPayment: "0" })).toThrow(RangeError);
    expect(() => createPayingClient({ ...options, maxAmountPerPayment: "0.000000" })).toThrow(RangeError);
  });
});
