import type { Abi } from "viem";
import {
  arbitrationAbi,
  claimMarketAbi,
  erc20Abi,
  keeperEvaluatorAbi,
  policyRegistryAbi,
  squareHookAbi,
  squareJobAbi,
} from "./abi/index.js";

/**
 * Every custom error any Square contract can raise, so a revert that crosses a
 * contract boundary still decodes to a name.
 *
 * The kernel re-raises its hook's revert data verbatim (`SquareJob._callHook`),
 * `ClaimMarket.payeeOf` reaches `SquareJob.InvalidJob` through `providerOf`,
 * and `KeeperEvaluator` reaches into `Arbitration`. viem decodes a revert by
 * looking its selector up in the ABI it was handed for the call, and a call
 * handed one contract's ABI cannot name another contract's error: the two
 * errors `SquareHook` exists to raise were exactly the two a `submit` caller
 * could trigger, and both came back as "Unable to decode signature" (#268).
 *
 * Only error items are collected. Function items stay with the contract the
 * call is for, so no function name can shadow another contract's.
 */
/** viem re-exports `Abi` but not the item types, so the error item is taken from it. */
type AbiError = Extract<Abi[number], { type: "error" }>;

const signature = (e: AbiError): string => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

const SOURCES: readonly Abi[] = [
  squareJobAbi,
  squareHookAbi,
  claimMarketAbi,
  arbitrationAbi,
  keeperEvaluatorAbi,
  policyRegistryAbi,
  erc20Abi,
];

export const SQUARE_ERRORS: readonly AbiError[] = (() => {
  const seen = new Map<string, AbiError>();
  for (const abi of SOURCES) {
    for (const item of abi) {
      if (item.type === "error" && !seen.has(signature(item))) seen.set(signature(item), item);
    }
  }
  return [...seen.values()];
})();

/**
 * `abi` plus every Square error it does not already declare. The runtime value
 * is a superset of `abi`; the type is left as `TAbi` so the function names and
 * return types viem infers from the original are untouched. A revert selector
 * from any Square contract now resolves whichever contract the call was for.
 */
export function withSquareErrors<TAbi extends Abi>(abi: TAbi): TAbi {
  const own = new Set(abi.filter((i): i is AbiError => i.type === "error").map(signature));
  const extra = SQUARE_ERRORS.filter((e) => !own.has(signature(e)));
  return [...abi, ...extra] as unknown as TAbi;
}
