import {
  getAddress,
  isAddress,
  isHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type ReadContractParameters,
  type SendTransactionParameters,
  type Transport,
  type VerifyTypedDataActionParameters,
  type WalletClient,
  type WriteContractParameters,
} from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { chainIdOf } from "./network.js";
import { silentLogger, type GatewayLogger } from "./logger.js";
import type { ReplayEntry, ReplayKey, ReplayStore } from "./replay-store.js";

export type { GatewayLogger } from "./logger.js";

export interface PaymentAllowlistEntry {
  payTo: Address;
  asset: Address;
  network: Network;
}

export interface SquareFacilitatorOptions {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  network: Network;
  replayStore: ReplayStore;
  allowlist: PaymentAllowlistEntry[];
  logger?: GatewayLogger;
  confirmationTimeoutMs?: number;
}

export interface SquareFacilitator extends FacilitatorClient {
  readonly facilitator: x402Facilitator;
  readonly address: Address;
  readonly network: Network;
}

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface Eip3009PaymentPayload {
  authorization: Eip3009Authorization;
  signature: Hex;
}

export const REJECTION = {
  unsupportedVersion: "unsupported_x402_version",
  unsupportedScheme: "unsupported_scheme",
  networkNotAllowed: "network_not_allowed",
  networkMismatch: "accepted_network_mismatch",
  payToNotAllowed: "pay_to_not_allowed",
  assetNotAllowed: "asset_not_allowed",
  acceptedMismatch: "accepted_requirements_mismatch",
  invalidAmount: "invalid_amount",
  unsupportedPayload: "unsupported_payload",
  recipientMismatch: "authorization_recipient_mismatch",
  amountBelowRequired: "authorization_value_below_required",
  replayed: "replayed_authorization",
  validBeforeTooFar: "invalid_valid_before",
} as const;

export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
export const VALID_BEFORE_SKEW_SECONDS = 300;

const SETTLEMENT_PENDING = "settlement_pending";
const SETTLED_WITHOUT_HASH = "settled_without_transaction_hash";
const INTEGER = /^\d+$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

function transactionHash(value: unknown): Hex | undefined {
  return typeof value === "string" && TRANSACTION_HASH.test(value) ? (value as Hex) : undefined;
}

function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b);
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && INTEGER.test(value);
}

export function readEip3009Payload(raw: Record<string, unknown>): Eip3009PaymentPayload | undefined {
  const authorization = raw["authorization"];
  const signature = raw["signature"];
  if (typeof authorization !== "object" || authorization === null) {
    return undefined;
  }
  const a = authorization as Record<string, unknown>;
  const from = a["from"];
  const to = a["to"];
  const nonce = a["nonce"];
  if (typeof from !== "string" || !isAddress(from)) return undefined;
  if (typeof to !== "string" || !isAddress(to)) return undefined;
  if (typeof nonce !== "string" || !isHex(nonce) || nonce.length !== 66) return undefined;
  if (!isIntegerString(a["value"])) return undefined;
  if (!isIntegerString(a["validAfter"])) return undefined;
  if (!isIntegerString(a["validBefore"])) return undefined;
  if (typeof signature !== "string" || !isHex(signature)) return undefined;
  return {
    authorization: {
      from: getAddress(from),
      to: getAddress(to),
      value: a["value"],
      validAfter: a["validAfter"],
      validBefore: a["validBefore"],
      nonce,
    },
    signature,
  };
}

export function replayKeyFromPayload(payload: PaymentPayload): ReplayKey | undefined {
  const eip3009 = readEip3009Payload(payload.payload);
  const accepted = payload.accepted;
  if (!eip3009 || !accepted || !isAddress(accepted.asset)) {
    return undefined;
  }
  let chainId: number;
  try {
    chainId = chainIdOf(accepted.network);
  } catch {
    return undefined;
  }
  return {
    chainId,
    asset: getAddress(accepted.asset),
    payer: eip3009.authorization.from,
    nonce: eip3009.authorization.nonce,
  };
}

function replayEntry(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009: Eip3009PaymentPayload
): ReplayEntry {
  return {
    chainId: chainIdOf(requirements.network),
    asset: getAddress(requirements.asset),
    payer: eip3009.authorization.from,
    nonce: eip3009.authorization.nonce,
    amount: BigInt(eip3009.authorization.value),
    payTo: getAddress(requirements.payTo),
    resource: payload.resource?.url ?? "",
    validBefore: BigInt(eip3009.authorization.validBefore),
  };
}

export interface AllowlistVerdict {
  ok: boolean;
  reason?: string;
  eip3009?: Eip3009PaymentPayload;
}

function declaredTimeoutSeconds(requirements: PaymentRequirements): number {
  const declared = requirements.maxTimeoutSeconds;
  return typeof declared === "number" && Number.isInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TIMEOUT_SECONDS;
}

export function validBeforeCeiling(requirements: PaymentRequirements, nowSeconds: number): bigint {
  return BigInt(nowSeconds) + BigInt(declaredTimeoutSeconds(requirements)) + BigInt(VALID_BEFORE_SKEW_SECONDS);
}

export function checkAgainstAllowlist(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  allowlist: PaymentAllowlistEntry[],
  network: Network,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AllowlistVerdict {
  if (payload.x402Version !== 2) {
    return { ok: false, reason: REJECTION.unsupportedVersion };
  }
  const accepted = payload.accepted;
  if (requirements.scheme !== "exact" || accepted?.scheme !== "exact") {
    return { ok: false, reason: REJECTION.unsupportedScheme };
  }
  if (requirements.network !== network) {
    return { ok: false, reason: REJECTION.networkNotAllowed };
  }
  if (accepted.network !== requirements.network) {
    return { ok: false, reason: REJECTION.networkMismatch };
  }
  if (!isAddress(requirements.payTo) || !isAddress(requirements.asset)) {
    return { ok: false, reason: REJECTION.payToNotAllowed };
  }
  const forPayee = allowlist.filter(
    (entry) => entry.network === requirements.network && sameAddress(entry.payTo, requirements.payTo)
  );
  if (forPayee.length === 0) {
    return { ok: false, reason: REJECTION.payToNotAllowed };
  }
  if (!forPayee.some((entry) => sameAddress(entry.asset, requirements.asset))) {
    return { ok: false, reason: REJECTION.assetNotAllowed };
  }
  if (!sameAddress(accepted.payTo, requirements.payTo) || !sameAddress(accepted.asset, requirements.asset)) {
    return { ok: false, reason: REJECTION.acceptedMismatch };
  }
  if (!isIntegerString(requirements.amount) || BigInt(requirements.amount) <= 0n) {
    return { ok: false, reason: REJECTION.invalidAmount };
  }
  if (accepted.amount !== requirements.amount) {
    return { ok: false, reason: REJECTION.acceptedMismatch };
  }
  const eip3009 = readEip3009Payload(payload.payload);
  if (!eip3009) {
    return { ok: false, reason: REJECTION.unsupportedPayload };
  }
  if (!sameAddress(eip3009.authorization.to, requirements.payTo)) {
    return { ok: false, reason: REJECTION.recipientMismatch };
  }
  if (BigInt(eip3009.authorization.value) < BigInt(requirements.amount)) {
    return { ok: false, reason: REJECTION.amountBelowRequired };
  }
  if (BigInt(eip3009.authorization.validBefore) > validBeforeCeiling(requirements, nowSeconds)) {
    return { ok: false, reason: REJECTION.validBeforeTooFar };
  }
  return { ok: true, eip3009 };
}

function buildSigner(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: PublicClient,
  confirmationTimeoutMs: number | undefined
): FacilitatorEvmSigner {
  const account = walletClient.account;
  const chain = walletClient.chain;
  return toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (args) => publicClient.readContract(args as unknown as ReadContractParameters),
      verifyTypedData: (args) =>
        publicClient.verifyTypedData(args as unknown as VerifyTypedDataActionParameters),
      writeContract: (args) =>
        walletClient.writeContract({ ...args, account, chain } as unknown as WriteContractParameters),
      sendTransaction: (args) =>
        walletClient.sendTransaction({ ...args, account, chain } as unknown as SendTransactionParameters),
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
      getCode: (args) => publicClient.getCode(args),
    },
    confirmationTimeoutMs === undefined ? {} : { confirmationTimeoutMs }
  );
}

export function createSquareFacilitator(options: SquareFacilitatorOptions): SquareFacilitator {
  const { walletClient, publicClient, network, replayStore, allowlist } = options;
  const logger = options.logger ?? silentLogger;
  chainIdOf(network);
  if (allowlist.length === 0) {
    throw new Error("createSquareFacilitator: the allowlist must contain at least one payee");
  }
  const signer = buildSigner(walletClient, publicClient, options.confirmationTimeoutMs);
  const facilitator = new x402Facilitator().register(network, new ExactEvmScheme(signer));

  facilitator.onBeforeVerify(async ({ paymentPayload, requirements }) => {
    const verdict = checkAgainstAllowlist(paymentPayload, requirements, allowlist, network);
    if (!verdict.ok || !verdict.eip3009) {
      logger.warn("x402 verify rejected", { reason: verdict.reason });
      return { abort: true, reason: verdict.reason ?? REJECTION.unsupportedPayload };
    }
    const key = replayEntry(paymentPayload, requirements, verdict.eip3009);
    if (await replayStore.has(key)) {
      logger.warn("x402 verify rejected", { reason: REJECTION.replayed, payer: key.payer, nonce: key.nonce });
      return { abort: true, reason: REJECTION.replayed };
    }
    return undefined;
  });

  facilitator.onAfterVerify(async ({ paymentPayload, requirements }) => {
    const eip3009 = readEip3009Payload(paymentPayload.payload);
    if (!eip3009) {
      throw new Error(REJECTION.unsupportedPayload);
    }
    const entry = replayEntry(paymentPayload, requirements, eip3009);
    const inserted = await replayStore.insertAccepted(entry);
    if (!inserted) {
      logger.warn("x402 verify lost the replay race", { payer: entry.payer, nonce: entry.nonce });
      throw new Error(REJECTION.replayed);
    }
    logger.info("x402 payment accepted", {
      payer: entry.payer,
      nonce: entry.nonce,
      amount: entry.amount.toString(),
      resource: entry.resource,
    });
  });

  facilitator.onBeforeSettle(async ({ paymentPayload, requirements }) => {
    const verdict = checkAgainstAllowlist(paymentPayload, requirements, allowlist, network);
    if (!verdict.ok) {
      logger.warn("x402 settle rejected", { reason: verdict.reason });
      return { abort: true, reason: verdict.reason ?? REJECTION.unsupportedPayload };
    }
    return undefined;
  });

  facilitator.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
    const eip3009 = readEip3009Payload(paymentPayload.payload);
    if (!eip3009) {
      return;
    }
    const key = replayEntry(paymentPayload, requirements, eip3009);
    const transaction = transactionHash(result.transaction);
    if (result.success) {
      if (transaction === undefined) {
        logger.error("x402 settle reported success without a transaction hash", { payer: key.payer, nonce: key.nonce });
        const settled = await replayStore.markSettled(key, null, SETTLED_WITHOUT_HASH);
        if (!settled) {
          logger.error("x402 ledger refused the settled transition", { payer: key.payer, nonce: key.nonce });
        }
        return;
      }
      const held = await replayStore.markSettled(key, transaction);
      logger.info("x402 payment settled", { payer: key.payer, nonce: key.nonce, transaction });
      if (!held) {
        logger.error("x402 ledger refused the settled transition", { payer: key.payer, nonce: key.nonce, transaction });
      }
      return;
    }
    if (result.errorReason === SETTLEMENT_PENDING) {
      if (transaction === undefined) {
        logger.error("x402 settlement pending without a transaction hash", { payer: key.payer, nonce: key.nonce });
        return;
      }
      const recorded = await replayStore.markPending(key, transaction);
      logger.warn("x402 settlement pending, left to reconciliation", {
        payer: key.payer,
        nonce: key.nonce,
        transaction,
        recorded,
      });
      return;
    }
    await markFailed(key, result.errorReason ?? "settle_failed", transaction);
    logger.error("x402 settlement failed", {
      payer: key.payer,
      nonce: key.nonce,
      reason: result.errorReason,
      transaction,
    });
  });

  facilitator.onSettleFailure(async ({ paymentPayload, requirements, error }) => {
    const eip3009 = readEip3009Payload(paymentPayload.payload);
    if (!eip3009) {
      return;
    }
    const key = replayEntry(paymentPayload, requirements, eip3009);
    await markFailed(key, error.message);
    logger.error("x402 settlement threw", { payer: key.payer, nonce: key.nonce, error: error.message });
  });

  async function markFailed(key: ReplayKey, reason: string, txHash?: Hex): Promise<void> {
    const held = await replayStore.markFailed(key, reason, txHash);
    if (!held) {
      logger.error("x402 ledger refused the failed transition", { payer: key.payer, nonce: key.nonce, reason });
    }
  }

  return {
    facilitator,
    address: walletClient.account.address,
    network,
    verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
      return facilitator.verify(paymentPayload, paymentRequirements);
    },
    settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
      return facilitator.settle(paymentPayload, paymentRequirements);
    },
    async getSupported(): Promise<SupportedResponse> {
      return facilitator.getSupported() as SupportedResponse;
    },
  };
}
