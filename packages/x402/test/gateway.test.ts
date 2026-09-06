import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { erc20Abi, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  ARC_TESTNET_NETWORK,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  usdcAsset,
} from "../src/network.js";
import { REJECTION, createSquareFacilitator, replayKeyFromPayload, type SquareFacilitator } from "../src/facilitator.js";
import { memoryReplayStore, type MemoryReplayStore } from "../src/replay-store.js";
import { createGatewayApp } from "../src/server.js";
import { createPayingClient, createPayingFetch } from "../src/client.js";
import { PAYEE_ADDRESS, PAYER_KEY, deployMockUsdc, startAnvil, type AnvilHandle, type LocalChain } from "./anvil.js";

const PRICE = "0.05";
const PRICE_ATOMIC = 50_000n;
const payer = privateKeyToAccount(PAYER_KEY);

let anvil: AnvilHandle;
let local: LocalChain;
let server: ServerType;
let baseUrl: string;
let replayStore: MemoryReplayStore;
let facilitator: SquareFacilitator;
let capturedSignature: string | undefined;

async function balanceOf(address: Address): Promise<bigint> {
  return local.publicClient.readContract({
    address: local.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

function capturingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const header = request.headers.get(PAYMENT_SIGNATURE_HEADER);
  if (header) {
    capturedSignature = header;
  }
  return fetch(request);
}

function listen(app: { fetch: (req: Request) => Response | Promise<Response> }): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({ server: started, url: `http://127.0.0.1:${info.port}` });
    });
  });
}

beforeAll(async () => {
  anvil = await startAnvil();
  local = await deployMockUsdc(anvil.rpcUrl, payer.address, 10_000_000n);
  replayStore = memoryReplayStore();
  facilitator = createSquareFacilitator({
    walletClient: local.deployerWallet,
    publicClient: local.publicClient,
    network: ARC_TESTNET_NETWORK,
    replayStore,
    allowlist: [{ payTo: PAYEE_ADDRESS, asset: local.usdc, network: ARC_TESTNET_NETWORK }],
  });
  const app = createGatewayApp({
    payTo: PAYEE_ADDRESS,
    network: ARC_TESTNET_NETWORK,
    facilitator,
    asset: local.usdc,
    routes: {
      "GET /quote": {
        price: PRICE,
        description: "A quote for agent work",
        handler: (c) => c.json({ quote: "42 USDC", validFor: 300 }),
      },
    },
  });
  const started = await listen(app);
  server = started.server;
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await anvil?.stop();
});

describe("gateway on local anvil", () => {
  it("serves /health without payment", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; network: string; asset: string };
    expect(body.ok).toBe(true);
    expect(body.network).toBe(ARC_TESTNET_NETWORK);
    expect(getAddress(body.asset)).toBe(getAddress(local.usdc));
  });

  it("answers an unpaid request with 402 and a PAYMENT-REQUIRED header for eip155:5042002", async () => {
    const res = await fetch(`${baseUrl}/quote`);
    expect(res.status).toBe(402);
    const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(header).toBeTruthy();
    const required: PaymentRequired = decodePaymentRequiredHeader(header ?? "");
    expect(required.x402Version).toBe(2);
    const accept = required.accepts[0];
    expect(accept?.network).toBe("eip155:5042002");
    expect(accept?.scheme).toBe("exact");
    expect(accept?.amount).toBe(PRICE_ATOMIC.toString());
    expect(getAddress(accept?.asset ?? "0x")).toBe(getAddress(local.usdc));
    expect(getAddress(accept?.payTo ?? "0x")).toBe(PAYEE_ADDRESS);
    expect(accept?.extra).toMatchObject({ name: "USDC", version: "2", assetTransferMethod: "eip3009" });
  });

  it("pays, gets 200 with a settled PAYMENT-RESPONSE, and the payee balance grows by the price", async () => {
    const payeeBefore = await balanceOf(PAYEE_ADDRESS);
    const payerBefore = await balanceOf(payer.address);
    const payingFetch = createPayingFetch({
      account: payer,
      network: ARC_TESTNET_NETWORK,
      asset: local.usdc,
      fetch: capturingFetch,
    });
    const res = await payingFetch(`${baseUrl}/quote`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quote: "42 USDC", validFor: 300 });
    const header = res.headers.get(PAYMENT_RESPONSE_HEADER);
    expect(header).toBeTruthy();
    const settled = decodePaymentResponseHeader(header ?? "");
    expect(settled.success).toBe(true);
    expect(settled.network).toBe(ARC_TESTNET_NETWORK);
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(getAddress(settled.payer ?? "0x")).toBe(payer.address);
    const receipt = await local.publicClient.getTransactionReceipt({ hash: settled.transaction as Hex });
    expect(receipt.status).toBe("success");
    expect(receipt.gasUsed).toBeGreaterThan(0n);
    console.info(`transferWithAuthorization settlement gasUsed=${receipt.gasUsed.toString()}`);
    expect(await balanceOf(PAYEE_ADDRESS)).toBe(payeeBefore + PRICE_ATOMIC);
    expect(await balanceOf(payer.address)).toBe(payerBefore - PRICE_ATOMIC);
    expect(capturedSignature).toBeTruthy();
    const payload = decodePaymentSignatureHeader(capturedSignature ?? "");
    const key = replayKeyFromPayload(payload);
    expect(key).toBeDefined();
    expect(replayStore.get(key!)?.status).toBe("settled");
    expect(replayStore.get(key!)?.txHash).toBe(settled.transaction);
  });

  it("refuses the exact same PAYMENT-SIGNATURE when it is replayed by hand", async () => {
    expect(capturedSignature).toBeTruthy();
    const payeeBefore = await balanceOf(PAYEE_ADDRESS);
    const res = await fetch(`${baseUrl}/quote`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: capturedSignature ?? "" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(402);
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    const required = decodePaymentRequiredHeader(res.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
    expect(required.error).toBe(REJECTION.replayed);
    expect(await balanceOf(PAYEE_ADDRESS)).toBe(payeeBefore);
    const key = replayKeyFromPayload(decodePaymentSignatureHeader(capturedSignature ?? ""));
    expect(await replayStore.has(key!)).toBe(true);
    expect(replayStore.get(key!)?.status).toBe("settled");
  });

  it("refuses a direct settle of the already settled authorization without changing the record", async () => {
    const payload = decodePaymentSignatureHeader(capturedSignature ?? "");
    const payeeBefore = await balanceOf(PAYEE_ADDRESS);
    const result = await facilitator.settle(payload, payload.accepted);
    expect(result.success).toBe(false);
    expect(await balanceOf(PAYEE_ADDRESS)).toBe(payeeBefore);
    const key = replayKeyFromPayload(payload);
    expect(replayStore.get(key!)?.status).toBe("settled");
  });
});

describe("verifier", () => {
  function requirementsFor(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
    const price = usdcAsset(PRICE, local.usdc);
    return {
      scheme: "exact",
      network: ARC_TESTNET_NETWORK,
      asset: price.asset,
      amount: price.amount,
      payTo: PAYEE_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: { ...price.extra },
      ...overrides,
    };
  }

  async function signedPayload(requirements: PaymentRequirements): Promise<PaymentPayload> {
    const client = createPayingClient({ account: payer, network: ARC_TESTNET_NETWORK, asset: requirements.asset as Address });
    return client.createPaymentPayload({
      x402Version: 2,
      resource: { url: `${baseUrl}/quote` },
      accepts: [requirements],
    });
  }

  it("accepts a fresh authorization once and refuses it the second time before settlement", async () => {
    const requirements = requirementsFor();
    const payload = await signedPayload(requirements);
    const first = await facilitator.verify(payload, requirements);
    expect(first.isValid).toBe(true);
    expect(getAddress(first.payer ?? "0x")).toBe(payer.address);
    const key = replayKeyFromPayload(payload);
    expect(await replayStore.has(key!)).toBe(true);
    expect(replayStore.get(key!)?.status).toBe("accepted");
    const second = await facilitator.verify(payload, requirements);
    expect(second.isValid).toBe(false);
    expect(second.invalidReason).toBe(REJECTION.replayed);
  });

  it("refuses a payTo that is not allowlisted", async () => {
    const other = getAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906");
    const requirements = requirementsFor({ payTo: other });
    const payload = await signedPayload(requirements);
    const result = await facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.payToNotAllowed);
  });

  it("refuses an authorization whose recipient differs from the allowlisted payTo", async () => {
    const requirements = requirementsFor();
    const payload = await signedPayload(requirements);
    const authorization = payload.payload["authorization"] as { to: string };
    authorization.to = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    const result = await facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.recipientMismatch);
  });

  it("refuses a different asset address", async () => {
    const otherAsset = getAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
    const requirements = requirementsFor({ asset: otherAsset });
    const payload = await signedPayload(requirements);
    const result = await facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.assetNotAllowed);
  });

  it("refuses an authorization value below the required amount", async () => {
    const requirements = requirementsFor();
    const payload = await signedPayload(requirements);
    const authorization = payload.payload["authorization"] as { value: string };
    authorization.value = (PRICE_ATOMIC - 1n).toString();
    const result = await facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.amountBelowRequired);
  });

  it("refuses a payload whose accepted amount was lowered below the requirement", async () => {
    const cheaper = requirementsFor({ amount: (PRICE_ATOMIC - 10_000n).toString() });
    const payload = await signedPayload(cheaper);
    const result = await facilitator.verify(payload, requirementsFor());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.acceptedMismatch);
  });

  it("refuses x402 v1 payloads", async () => {
    const requirements = requirementsFor();
    const payload = await signedPayload(requirements);
    const result = await facilitator.verify({ ...payload, x402Version: 1 }, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(REJECTION.unsupportedVersion);
  });

  it("advertises exactly the configured network and the facilitator signer", async () => {
    const supported = await facilitator.getSupported();
    expect(supported.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: ARC_TESTNET_NETWORK }]);
    expect(supported.signers["eip155:*"]).toEqual([facilitator.address]);
  });
});
