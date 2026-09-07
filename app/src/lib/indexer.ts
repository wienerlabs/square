"use client";

import { useQuery } from "@tanstack/react-query";
import { POLL_MS } from "./square";

const configured = (process.env.NEXT_PUBLIC_INDEXER_URL ?? "").trim().replace(/\/+$/, "");

export const indexerUrl: string | null = configured.length > 0 ? configured : null;

export interface IndexerJob {
  chainId: number;
  jobId: string;
  client: string;
  provider: string | null;
  evaluator: string;
  hook: string | null;
  description: string;
  budget: string;
  status: number;
  expiredAt: string;
  createdAt: string;
  fundedAt: string | null;
  submittedAt: string | null;
  challengeEnd: string | null;
  disputed: boolean;
  agentId: string | null;
  updatedBlock: string;
}

export interface IndexerStatus {
  chainId: number;
  lastIndexedBlock: string | null;
  chainHead: string;
  jobs: number;
}

export interface IndexerOverview {
  status: IndexerStatus;
  open: IndexerJob[];
  inWindow: IndexerJob[];
  finalizable: IndexerJob[];
}

async function fetchJson<T>(path: string): Promise<T> {
  if (!indexerUrl) throw new Error("the indexer is not configured");
  const response = await fetch(`${indexerUrl}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the indexer answered ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export function useIndexerOverview() {
  return useQuery({
    queryKey: ["indexer", "overview", indexerUrl],
    enabled: indexerUrl !== null,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<IndexerOverview> => {
      const [status, open, inWindow, finalizable] = await Promise.all([
        fetchJson<IndexerStatus>("/status"),
        fetchJson<IndexerJob[]>("/jobs/open"),
        fetchJson<IndexerJob[]>("/jobs/in-window"),
        fetchJson<IndexerJob[]>("/jobs/finalizable"),
      ]);
      return { status, open, inWindow, finalizable };
    },
  });
}

export function useIndexerStatus() {
  return useQuery({
    queryKey: ["indexer", "status", indexerUrl],
    enabled: indexerUrl !== null,
    refetchInterval: POLL_MS,
    queryFn: () => fetchJson<IndexerStatus>("/status"),
  });
}
