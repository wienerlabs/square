"use client";

import { useQuery } from "@tanstack/react-query";
import { POLL_MS } from "./square";

const configured = (process.env.NEXT_PUBLIC_INDEXER_URL ?? "").trim().replace(/\/+$/, "");

export const indexerUrl: string | null = configured.length > 0 ? configured : null;

export interface IndexerStatus {
  chainId: number;
  lastIndexedBlock: string | null;
  chainHead: string;
  jobs: number;
}

export interface IndexerCounts {
  open: number;
  inWindow: number;
  finalizable: number;
}

export interface IndexerOverview extends IndexerStatus {
  counts: IndexerCounts;
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
    queryFn: () => fetchJson<IndexerOverview>("/overview"),
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
