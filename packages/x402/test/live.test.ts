import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import {
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  arcTestnetWithRpc,
} from "../src/network.js";
import { REJECTION, createSquareFacilitator, replayKeyFromPayload } from "../src/facilitator.js";
import { memoryReplayStore } from "../src/replay-store.js";
import { createGatewayApp } from "../src/server.js";
import { createPayingFetch } from "../src/client.js";

const live = process.env.LIVE_X402 === "1";
const rpcUrl = process.env.ARC_TESTNET_RPC_URL;
const facilitatorKey = process.env.X402_FACILITATOR_PRIVATE_KEY;
const payerKey = process.env.X402_PAYER_PRIVATE_KEY;
const configured = live && !!rpcUrl && !!facilitatorKey && !!payerKey;

if (live && !configured) {
  console.warn("LIVE_X402=1 but ARC_TESTNET_RPC_URL, X402_FACILITATOR_PRIVATE_KEY or X402_PAYER_PRIVATE_KEY is missing; skipping");
}

const PRICE = "0.01";
const PRICE_ATOMIC = 10_000n;

describe.skipIf(!configured)("Arc testnet, real USDC", () => {
  let server: ServerType;
  let baseUrl: string;
  let publicClient: PublicClient;
  let payee: Address;
  let payerAddress: Address;
  let captured: string | undefined;
  const replayStore = memoryReplayStore();

  async function balanceOf(address: Address): Promise<bigint> {
    return publicClient.readContract({ address: ARC_TESTNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  }

  beforeAll(async () => {
    const chain = arcTestnetWithRpc(rpcUrl ?? "");
    const facilitatorAccount = privateKeyToAccount(facilitatorKey as Hex);
    const payer = privateKeyToAccount(payerKey as Hex);
    payerAddress = payer.address;
    payee = (process.env.X402_PAYEE_ADDRESS as Address | undefined) ?? facilitatorAccount.address;
    publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account: facilitatorAccount, chain, transport: http(rpcUrl) });
    const facilitator = createSquareFacilitator({
      walletClient,
      publicClient,
      network: ARC_TESTNET_NETWORK,
      replayStore,
      allowlist: [{ payTo: payee, asset: ARC_TESTNET_USDC, network: ARC_TESTNET_NETWORK }],
      logger: console,
    });
    const app = createGatewayApp({
      payTo: payee,
      network: ARC_TESTNET_NETWORK,
      facilitator,
      routes: {
        "GET /quote": { price: PRICE, description: "live quote", handler: (c) => c.json({ quote: "live" }) },
      },
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("returns 402 with Arc requirements when unpaid", async () => {
    const res = await fetch(`${baseUrl}/quote`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
    expect(required.accepts[0]?.network).toBe(ARC_TESTNET_NETWORK);
    expect(getAddress(required.accepts[0]?.asset ?? "0x")).toBe(ARC_TESTNET_USDC);
  });

  it("settles a real transferWithAuthorization on Arc testnet", async () => {
    const payeeBefore = await balanceOf(payee);
    const payingFetch = createPayingFetch({
      account: privateKeyToAccount(payerKey as Hex),
      network: ARC_TESTNET_NETWORK,
      maxAmountPerPayment: "1.00",
      fetch: (input, init) => {
        const request = new Request(input, init);
        captured = request.headers.get(PAYMENT_SIGNATURE_HEADER) ?? captured;
        return fetch(request);
      },
    });
    const res = await payingFetch(`${baseUrl}/quote`);
    expect(res.status).toBe(200);
    const settled = decodePaymentResponseHeader(res.headers.get(PAYMENT_RESPONSE_HEADER) ?? "");
    expect(settled.success).toBe(true);
    const receipt = await publicClient.getTransactionReceipt({ hash: settled.transaction as Hex });
    expect(receipt.status).toBe("success");
    console.info(`Arc testnet settlement ${settled.transaction} gasUsed=${receipt.gasUsed.toString()}`);
    expect(await balanceOf(payee)).toBe(payeeBefore + PRICE_ATOMIC);
    expect(getAddress(settled.payer ?? "0x")).toBe(payerAddress);
  });

  it("refuses the replayed header", async () => {
    const res = await fetch(`${baseUrl}/quote`, { headers: { [PAYMENT_SIGNATURE_HEADER]: captured ?? "" } });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
    expect(required.error).toBe(REJECTION.replayed);
    const key = replayKeyFromPayload(decodePaymentSignatureHeader(captured ?? ""));
    expect(await replayStore.has(key!)).toBe(true);
  });
});
