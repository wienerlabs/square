"use client";

import {
  arbitrationAbi,
  createSquareClient,
  JobStatus,
  keeperEvaluatorAbi,
  squareHookAbi,
  squareJobAbi,
  type SquareClient,
} from "@squaresdk/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { zeroAddress, type Address } from "viem";
import { useWalletClient } from "wagmi";
import { keeperEvaluates } from "./actions";
import { activeChain, deployment, publicClient } from "./wagmi";

export const POLL_MS = 10_000;
export const RECENT_JOB_WINDOW = 50;

const chainId = activeChain.id;
const readOnlyClient = createSquareClient({ publicClient, deployment });

export function useSquare(): SquareClient {
  const { data: walletClient } = useWalletClient();
  return useMemo(() => {
    if (!walletClient) return readOnlyClient;
    return createSquareClient({ publicClient, walletClient, deployment });
  }, [walletClient]);
}

export type JobRecord = Awaited<ReturnType<SquareClient["getJobRecord"]>>;
export type Listing = Awaited<ReturnType<SquareClient["listing"]>>;
export type ArbitrationDispute = Awaited<ReturnType<SquareClient["disputeOf"]>>;

export interface KeeperDispute {
  disputer: Address;
  disputedAt: number;
  resolved: boolean;
}

export interface KeeperWindow {
  effectiveFrom: number;
  challengeWindow: number;
  disputeWindow: number;
}

export interface JobSummary {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  budget: bigint;
  status: number;
  createdAt: number;
  fundedAt: number;
  expiredAt: number;
  submittedAt: number;
  challengeEnd: number;
  disputed: boolean;
  platformFeeBP: number;
  evaluatorFeeBP: number;
  providerBps: number;
}

export interface JobsSnapshot {
  counter: bigint;
  jobs: JobSummary[];
  scanned: number;
}

async function readJobSummary(id: bigint): Promise<JobSummary> {
  const record = await readOnlyClient.getJobRecord(id);
  let challengeEnd = 0;
  let disputed = false;
  if (record.status === JobStatus.Submitted && keeperEvaluates(record, deployment.keeperEvaluator)) {
    [challengeEnd, disputed] = await Promise.all([readOnlyClient.challengeEndsAt(id), readOnlyClient.isDisputed(id)]);
  }
  return {
    id,
    client: record.client,
    provider: record.provider,
    evaluator: record.evaluator,
    budget: record.budget,
    status: record.status,
    createdAt: record.createdAt,
    fundedAt: record.fundedAt,
    expiredAt: record.expiredAt,
    submittedAt: record.submittedAt,
    challengeEnd,
    disputed,
    platformFeeBP: record.platformFeeBP,
    evaluatorFeeBP: record.evaluatorFeeBP,
    providerBps: record.providerBps,
  };
}

export function useJobs(limit = RECENT_JOB_WINDOW) {
  return useQuery({
    queryKey: ["jobs", chainId, limit],
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<JobsSnapshot> => {
      const counter = await readOnlyClient.jobCounter();
      const ids: bigint[] = [];
      for (let id = counter; id >= 1n && ids.length < limit; id -= 1n) ids.push(id);
      const jobs = await Promise.all(ids.map((id) => readJobSummary(id)));
      return { counter, jobs, scanned: ids.length };
    },
  });
}

export interface JobDetail {
  id: bigint;
  record: JobRecord;
  challengeEnd: number;
  disputed: boolean;
  keeperDispute: KeeperDispute;
  dispute: ArbitrationDispute;
  listing: Listing;
  netPayout: bigint;
  payee: Address;
  agentId: bigint;
  expiryRecorded: boolean;
  bond: bigint;
  arbiters: readonly Address[];
  threshold: number;
}

export function useJob(id: bigint | null) {
  return useQuery({
    queryKey: ["job", chainId, id === null ? null : id.toString()],
    enabled: id !== null,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<JobDetail | null> => {
      if (id === null) return null;
      const counter = await readOnlyClient.jobCounter();
      if (id < 1n || id > counter) return null;
      const record = await readOnlyClient.getJobRecord(id);
      const keeperHoldsTheWindow = keeperEvaluates(record, deployment.keeperEvaluator);
      const [challengeEnd, disputed, keeperDispute, dispute, listing, netPayout, payee, agentId, expiryRecorded, bond] =
        await Promise.all([
          keeperHoldsTheWindow ? readOnlyClient.challengeEndsAt(id) : Promise.resolve(0),
          readOnlyClient.isDisputed(id),
          publicClient.readContract({
            abi: keeperEvaluatorAbi,
            address: deployment.keeperEvaluator,
            functionName: "disputeOf",
            args: [id],
          }),
          readOnlyClient.disputeOf(id),
          readOnlyClient.listing(id),
          readOnlyClient.netPayout(id).catch(() => 0n),
          readOnlyClient.payeeOf(id),
          readOnlyClient.agentOf(id),
          publicClient.readContract({
            abi: squareHookAbi,
            address: deployment.squareHook,
            functionName: "recorded",
            args: [id],
          }),
          readOnlyClient.bondFor(record.budget),
        ]);
      let arbiters: readonly Address[] = [];
      let threshold = 0;
      if (dispute.disputedAt !== 0) {
        const [set, required] = await publicClient.readContract({
          abi: arbitrationAbi,
          address: deployment.arbitration,
          functionName: "arbiterSet",
          args: [dispute.setVersion],
        });
        arbiters = set;
        threshold = required;
      }
      return {
        id,
        record,
        challengeEnd,
        disputed,
        keeperDispute: {
          disputer: keeperDispute.disputer,
          disputedAt: Number(keeperDispute.disputedAt),
          resolved: keeperDispute.resolved,
        },
        dispute,
        listing,
        netPayout,
        payee,
        agentId,
        expiryRecorded,
        bond,
        arbiters,
        threshold,
      };
    },
  });
}

export interface NetworkInfo {
  blockNumber: bigint;
  jobCounter: bigint;
  settlementHorizon: number;
  window: KeeperWindow;
  platformFeeBP: number;
  evaluatorFeeBP: number;
  maxTotalFeeBP: bigint;
  treasury: Address;
  totalWithdrawable: bigint;
  arbitrationAddress: Address;
  arbiterVersion: number;
  arbiters: readonly Address[];
  threshold: number;
  bondBps: number;
  minBond: bigint;
  complianceModule: Address;
}

export function useNetwork() {
  return useQuery({
    queryKey: ["network", chainId],
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<NetworkInfo> => {
      const squareJob = { abi: squareJobAbi, address: deployment.squareJob } as const;
      const keeper = { abi: keeperEvaluatorAbi, address: deployment.keeperEvaluator } as const;
      const arbitration = { abi: arbitrationAbi, address: deployment.arbitration } as const;
      const hook = { abi: squareHookAbi, address: deployment.squareHook } as const;
      const [
        blockNumber,
        jobCounter,
        settlementHorizon,
        window,
        platformFeeBP,
        evaluatorFeeBP,
        maxTotalFeeBP,
        treasury,
        totalWithdrawable,
        arbitrationAddress,
        arbiterVersion,
        bondParameters,
        complianceModule,
      ] = await Promise.all([
        publicClient.getBlockNumber(),
        readOnlyClient.jobCounter(),
        readOnlyClient.settlementHorizon(),
        publicClient.readContract({ ...keeper, functionName: "currentWindow" }),
        publicClient.readContract({ ...squareJob, functionName: "platformFeeBP" }),
        publicClient.readContract({ ...squareJob, functionName: "evaluatorFeeBP" }),
        publicClient.readContract({ ...squareJob, functionName: "MAX_TOTAL_FEE_BP" }),
        publicClient.readContract({ ...squareJob, functionName: "platformTreasury" }),
        publicClient.readContract({ ...squareJob, functionName: "totalWithdrawable" }),
        publicClient.readContract({ ...keeper, functionName: "arbitration" }),
        publicClient.readContract({ ...arbitration, functionName: "currentVersion" }),
        publicClient.readContract({ ...arbitration, functionName: "bondParameters" }),
        publicClient.readContract({ ...hook, functionName: "complianceModule" }),
      ]);
      const [arbiters, threshold] = await publicClient.readContract({
        ...arbitration,
        functionName: "arbiterSet",
        args: [arbiterVersion],
      });
      const [bondBps, minBond] = bondParameters;
      return {
        blockNumber,
        jobCounter,
        settlementHorizon,
        window: {
          effectiveFrom: Number(window.effectiveFrom),
          challengeWindow: Number(window.challengeWindow),
          disputeWindow: Number(window.disputeWindow),
        },
        platformFeeBP,
        evaluatorFeeBP,
        maxTotalFeeBP,
        treasury,
        totalWithdrawable,
        arbitrationAddress,
        arbiterVersion,
        arbiters,
        threshold,
        bondBps,
        minBond,
        complianceModule,
      };
    },
  });
}

export interface Positions {
  withdrawable: bigint;
  bondWithdrawable: bigint;
  usdcBalance: bigint;
}

export function usePositions(address: Address | undefined) {
  return useQuery({
    queryKey: ["positions", chainId, address ?? null],
    enabled: address !== undefined,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<Positions> => {
      const owner = address ?? zeroAddress;
      const [withdrawable, bondWithdrawable, usdcBalance] = await Promise.all([
        readOnlyClient.withdrawable(owner),
        readOnlyClient.bondWithdrawable(owner),
        readOnlyClient.usdcBalance(owner),
      ]);
      return { withdrawable, bondWithdrawable, usdcBalance };
    },
  });
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export { countVotes, jobPhase, LISTING_LABELS, OUTCOME_LABELS, PHASE_LABELS } from "./phase";
export type { JobPhase } from "./phase";
