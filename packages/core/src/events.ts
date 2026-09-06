import { parseEventLogs, type Address, type Log, type ParseEventLogsReturnType } from "viem";
import { arbitrationAbi, claimMarketAbi, keeperEvaluatorAbi, squareHookAbi, squareJobAbi } from "./abi/index.js";
import type { SquareDeployment } from "./deployments.js";

export type SquareContract = "SquareJob" | "KeeperEvaluator" | "Arbitration" | "ClaimMarket" | "SquareHook";

type Decoded<TAbi extends readonly unknown[]> = ParseEventLogsReturnType<TAbi, undefined, true>[number];

export type SquareJobEvent = { contract: "SquareJob" } & Decoded<typeof squareJobAbi>;
export type KeeperEvaluatorEvent = { contract: "KeeperEvaluator" } & Decoded<typeof keeperEvaluatorAbi>;
export type ArbitrationEvent = { contract: "Arbitration" } & Decoded<typeof arbitrationAbi>;
export type ClaimMarketEvent = { contract: "ClaimMarket" } & Decoded<typeof claimMarketAbi>;
export type SquareHookEvent = { contract: "SquareHook" } & Decoded<typeof squareHookAbi>;

export type SquareEvent =
  | SquareJobEvent
  | KeeperEvaluatorEvent
  | ArbitrationEvent
  | ClaimMarketEvent
  | SquareHookEvent;

const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

function decodeFor<TAbi extends readonly unknown[]>(
  contract: SquareContract,
  abi: TAbi,
  address: Address,
  logs: Log[],
): Array<{ contract: SquareContract } & Decoded<TAbi>> {
  const own = logs.filter((log) => sameAddress(log.address, address));
  if (own.length === 0) return [];
  const decoded = parseEventLogs({ abi, logs: own, strict: true }) as Decoded<TAbi>[];
  return decoded.map((entry) => ({ contract, ...entry }));
}

function position(log: { blockNumber: bigint | null; logIndex: number | null }): [bigint, number] {
  return [log.blockNumber ?? 0n, log.logIndex ?? 0];
}

export function decodeSquareLogs(logs: Log[], deployment: SquareDeployment): SquareEvent[] {
  const events: SquareEvent[] = [
    ...decodeFor("SquareJob", squareJobAbi, deployment.squareJob, logs),
    ...decodeFor("KeeperEvaluator", keeperEvaluatorAbi, deployment.keeperEvaluator, logs),
    ...decodeFor("Arbitration", arbitrationAbi, deployment.arbitration, logs),
    ...decodeFor("ClaimMarket", claimMarketAbi, deployment.claimMarket, logs),
    ...decodeFor("SquareHook", squareHookAbi, deployment.squareHook, logs),
  ] as SquareEvent[];
  return events.sort((a, b) => {
    const [blockA, indexA] = position(a);
    const [blockB, indexB] = position(b);
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    return indexA - indexB;
  });
}

export function eventsNamed<TName extends SquareEvent["eventName"]>(
  events: SquareEvent[],
  name: TName,
): Extract<SquareEvent, { eventName: TName }>[] {
  return events.filter((event): event is Extract<SquareEvent, { eventName: TName }> => event.eventName === name);
}
