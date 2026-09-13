import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { migrate, MIGRATIONS_DIR, pgliteDatabase, x402Payments, type Database } from "@squaresdk/data";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  REJECTION,
  VALID_BEFORE_SKEW_SECONDS,
  checkAgainstAllowlist,
  createSquareFacilitator,
  type PaymentAllowlistEntry,
} from "../src/facilitator.js";
import { postgresReplayStore, type ReplayEntry } from "../src/replay-store.js";
import { ARC_TESTNET_NETWORK, arcTestnet } from "../src/network.js";
import { PAYEE_ADDRESS, PAYER_KEY } from "./anvil.js";

const ASSET: Address = "0x3600000000000000000000000000000000000000";
const PRICE_ATOMIC = "50000";
const NONCE = ("0x" + "ab".repeat(32)) as Hex;
const SETTLEMENT_TX = ("0x" + "7f".repeat(32)) as Hex;
const EARLIER_TX = ("0x" + "5e".repeat(32)) as Hex;
const NOW_SECONDS = 1_800_000_000;

const payer = privateKeyToAccount(PAYER_KEY);

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function signAuthorization(validBefore: bigint): Promise<Hex> {
  return payer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: ASSET },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: payer.address,
      to: PAYEE_ADDRESS,
      value: BigInt(PRICE_ATOMIC),
      validAfter: 0n,
      validBefore,
      nonce: NONCE,
    },
  });
}
const allowlist: PaymentAllowlistEntry[] = [{ payTo: PAYEE_ADDRESS, asset: ASSET, network: ARC_TESTNET_NETWORK }];

function requirementsFor(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: ASSET,
    amount: PRICE_ATOMIC,
    payTo: PAYEE_ADDRESS,
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
    ...overrides,
  } as PaymentRequirements;
}

function payloadFor(validBefore: bigint, requirements: PaymentRequirements, signature: Hex): PaymentPayload {
  return {
    x402Version: 2,
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    accepted: requirements,
    resource: { url: "http://gateway.local/quote" },
    payload: {
      authorization: {
        from: payer.address,
        to: PAYEE_ADDRESS,
        value: PRICE_ATOMIC,
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce: NONCE,
      },
      signature,
    },
  } as unknown as PaymentPayload;
}

describe("checkAgainstAllowlist on validBefore", () => {
  const requirements = requirementsFor();
  const signature = ("0x" + "11".repeat(65)) as Hex;

  function verdictFor(validBefore: bigint) {
    return checkAgainstAllowlist(
      payloadFor(validBefore, requirements, signature),
      requirements,
      allowlist,
      ARC_TESTNET_NETWORK,
      NOW_SECONDS,
    );
  }

  it("accepts the deadline the offer itself declares", () => {
    expect(verdictFor(BigInt(NOW_SECONDS + DEFAULT_MAX_TIMEOUT_SECONDS)).ok).toBe(true);
  });

  it("accepts a payer clock that runs ahead by the allowed skew", () => {
    expect(verdictFor(BigInt(NOW_SECONDS + DEFAULT_MAX_TIMEOUT_SECONDS + VALID_BEFORE_SKEW_SECONDS)).ok).toBe(true);
  });

  it("refuses a deadline one second past the declared timeout plus the skew", () => {
    expect(verdictFor(BigInt(NOW_SECONDS + DEFAULT_MAX_TIMEOUT_SECONDS + VALID_BEFORE_SKEW_SECONDS + 1))).toEqual({
      ok: false,
      reason: REJECTION.validBeforeTooFar,
    });
  });

  it("refuses the unbounded deadline that used to poison the retention sweep", () => {
    expect(verdictFor(2n ** 62n)).toEqual({ ok: false, reason: REJECTION.validBeforeTooFar });
    expect(verdictFor(2n ** 63n - 1n)).toEqual({ ok: false, reason: REJECTION.validBeforeTooFar });
  });

  it("falls back to the protocol default when the offer declares no timeout", () => {
    const fields = requirementsFor() as unknown as Record<string, unknown>;
    delete fields["maxTimeoutSeconds"];
    const undeclared = fields as unknown as PaymentRequirements;
    const within = checkAgainstAllowlist(
      payloadFor(BigInt(NOW_SECONDS + DEFAULT_MAX_TIMEOUT_SECONDS), undeclared, signature),
      undeclared,
      allowlist,
      ARC_TESTNET_NETWORK,
      NOW_SECONDS,
    );
    const beyond = checkAgainstAllowlist(
      payloadFor(2n ** 62n, undeclared, signature),
      undeclared,
      allowlist,
      ARC_TESTNET_NETWORK,
      NOW_SECONDS,
    );
    expect(within.ok).toBe(true);
    expect(beyond).toEqual({ ok: false, reason: REJECTION.validBeforeTooFar });
  });
});

interface Receipt {
  status: "success" | "reverted";
  logs: unknown[];
}

function stubbedClients(receipt: Receipt) {
  const publicClient = {
    verifyTypedData: async () => true,
    getCode: async ({ address }: { address: Address }) =>
      address.toLowerCase() === ASSET.toLowerCase() ? ("0x60006000" as Hex) : ("0x" as Hex),
    readContract: async () => {
      throw new Error("the settle path must not read the token");
    },
    waitForTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: PAYEE_ADDRESS } as Account,
    chain: arcTestnet,
    writeContract: async () => SETTLEMENT_TX,
    sendTransaction: async () => SETTLEMENT_TX,
  } as unknown as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}

async function openLedger(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

describe("a settlement that fails after the transaction was broadcast", () => {
  async function settleAgainst(receipt: Receipt, run: (db: Database, entry: ReplayEntry) => Promise<void>): Promise<void> {
    const db = await openLedger();
    try {
      const { publicClient, walletClient } = stubbedClients(receipt);
      const store = postgresReplayStore(db);
      const square = createSquareFacilitator({
        walletClient,
        publicClient,
        network: ARC_TESTNET_NETWORK,
        replayStore: store,
        allowlist,
      });
      const requirements = requirementsFor();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_MAX_TIMEOUT_SECONDS);
      const signature = await signAuthorization(validBefore);
      const entry: ReplayEntry = {
        chainId: 5042002,
        asset: ASSET,
        payer: payer.address,
        nonce: NONCE,
        amount: BigInt(PRICE_ATOMIC),
        payTo: PAYEE_ADDRESS,
        resource: "http://gateway.local/quote",
        validBefore,
      };
      expect(await store.insertAccepted(entry)).toBe(true);

      const result = await square.settle(payloadFor(validBefore, requirements, signature), requirements);

      expect(result.success).toBe(false);
      expect(result.transaction).toBe(SETTLEMENT_TX);
      await run(db, entry);
    } finally {
      await db.close();
    }
  }

  it("writes the reverted transaction hash on the failed row", async () => {
    await settleAgainst({ status: "reverted", logs: [] }, async (db, entry) => {
      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(x402Payments.X402_STATUS.failed);
      expect(row?.reason).toBe("invalid_exact_evm_transaction_failed");
      expect(row?.txHash).toBe(SETTLEMENT_TX);
    });
  });

  it("writes the hash of a mined transaction that carried no matching Transfer event", async () => {
    await settleAgainst({ status: "success", logs: [] }, async (db, entry) => {
      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(x402Payments.X402_STATUS.failed);
      expect(row?.reason).toBe("invalid_exact_evm_transfer_event_mismatch");
      expect(row?.txHash).toBe(SETTLEMENT_TX);
    });
  });
});

describe("a settlement that failed before any transaction was broadcast", () => {
  it("leaves the hash the row already carried untouched", async () => {
    const db = await openLedger();
    try {
      const store = postgresReplayStore(db);
      const entry: ReplayEntry = {
        chainId: 5042002,
        asset: ASSET,
        payer: payer.address,
        nonce: NONCE,
        amount: BigInt(PRICE_ATOMIC),
        payTo: PAYEE_ADDRESS,
        resource: "http://gateway.local/quote",
        validBefore: 1_800_000_000n,
      };
      await store.insertAccepted(entry);
      await store.markPending(entry, EARLIER_TX);

      expect(await store.markFailed(entry, "settle_failed")).toBe(true);

      const row = await x402Payments.get(db, entry);
      expect(row?.status).toBe(x402Payments.X402_STATUS.failed);
      expect(row?.reason).toBe("settle_failed");
      expect(row?.txHash).toBe(EARLIER_TX);
    } finally {
      await db.close();
    }
  });
});
