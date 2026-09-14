import { describe, expect, it } from "vitest";
import {
  HttpRequestError,
  InvalidParamsRpcError,
  RpcRequestError,
  TimeoutError,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SIMPLE_ACCOUNT_FACTORY_V07, SIMPLE_ACCOUNT_IMPLEMENTATION_V07 } from "../src/constants.js";
import { isStateOverrideUnsupported } from "../src/errors.js";
import { createSelfBundler, DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT } from "../src/selfBundler.js";
import { toSimpleSmartAccount } from "../src/simpleAccount.js";

/**
 * What the undeployed account's gas hint does when the simulation cannot be
 * had. No fork here: the point is the failure, and a stub answers every
 * healthy read while the state-override estimateGas fails on cue (#297).
 *
 * Before, every failure that was not a revert became `undefined`, and the
 * bundler read `undefined` as "the node has no state overrides" and reserved
 * DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT. A timeout on Arc's endpoint changed what
 * the account paid, with nothing to say so; the deployed path threw on the
 * same timeout.
 */
const owner = privateKeyToAccount(generatePrivateKey());
const SENDER = "0x1111111111111111111111111111111111111111";
const word = (address: string): Hex => `0x${address.slice(2).padStart(64, "0")}`;

function stubClient(estimateCall: () => Hex) {
  const request = async ({ method, params }: { method: string; params: any[] }): Promise<unknown> => {
    const call = params?.[0] as { to?: string; data?: string } | undefined;
    const to = call?.to?.toLowerCase();
    const data = call?.data ?? "";
    if (method === "eth_call") {
      if (to === SIMPLE_ACCOUNT_FACTORY_V07.toLowerCase() && data.startsWith("0x8cb84e18")) return word(SENDER); // getAddress
      if (to === SIMPLE_ACCOUNT_FACTORY_V07.toLowerCase() && data.startsWith("0x11464fbe")) return word(SIMPLE_ACCOUNT_IMPLEMENTATION_V07); // accountImplementation
      if (data.startsWith("0x35567e1a")) return `0x${"0".repeat(64)}`; // getNonce
      throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
    }
    if (method === "eth_getCode") {
      const address = typeof params?.[0] === "string" ? (params[0] as string).toLowerCase() : undefined;
      return address === SIMPLE_ACCOUNT_IMPLEMENTATION_V07.toLowerCase() ? "0x6080" : "0x";
    }
    if (method === "eth_estimateGas") {
      if (to === SIMPLE_ACCOUNT_FACTORY_V07.toLowerCase()) return "0x30000"; // createAccount
      return estimateCall();
    }
    throw new Error(`unexpected ${method}`);
  };
  return { chain: { id: 5042002 }, request } as unknown as PublicClient<Transport, Chain>;
}

async function prepare(estimateCall: () => Hex) {
  const client = stubClient(estimateCall);
  const account = await toSimpleSmartAccount({ client, owner, salt: 1n });
  const bundler = createSelfBundler({
    walletClient: { account: owner, chain: { id: 5042002 } } as never,
    publicClient: client,
  });
  return bundler.prepareUserOperation(account, [{ to: owner.address, data: "0x" }], {
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
}

const invalidParams = () =>
  new InvalidParamsRpcError(
    new RpcRequestError({ body: {}, url: "http://stub", error: { code: -32602, message: "invalid params" } }),
  );

describe("the undeployed gas hint when the simulation cannot be had", () => {
  it("prices the call from a healthy estimate", async () => {
    const op = await prepare(() => "0x1d4c0");
    expect(op.callGasLimit).toBe(129_806n);
    expect(op.callGasLimit).not.toBe(DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT);
  });

  it("falls back to the documented constant only when the node has no state overrides", async () => {
    const op = await prepare(() => {
      throw invalidParams();
    });
    expect(op.callGasLimit).toBe(DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT);
  });

  for (const [label, failure] of [
    ["a timeout", () => new TimeoutError({ body: {}, url: "http://stub" })],
    ["a rate limit", () => new HttpRequestError({ url: "http://stub", status: 429, details: "rate limited" })],
    ["a dropped socket", () => new Error("socket hang up")],
  ] as const) {
    it(`throws on ${label}, as the deployed path does, instead of reserving the constant`, async () => {
      const attempt = prepare(() => {
        throw failure();
      });
      await expect(attempt).rejects.toThrow();
      await expect(attempt).rejects.not.toMatchObject({ callGasLimit: DEFAULT_UNDEPLOYED_CALL_GAS_LIMIT });
    });
  }

  it("names the unsupported-override answer and nothing else", () => {
    expect(isStateOverrideUnsupported(invalidParams())).toBe(true);
    expect(isStateOverrideUnsupported(new Error("state override not supported"))).toBe(false); // not a viem error
    expect(isStateOverrideUnsupported(new HttpRequestError({ url: "http://stub", status: 429 }))).toBe(false);
    expect(isStateOverrideUnsupported(new TimeoutError({ body: {}, url: "http://stub" }))).toBe(false);
  });
});
