"use client";

import { approveBuyers, buyerListFrom, JobStatus, type BuyerEntry, type BuyerList } from "@squaresdk/core";
import { newPolicy, parsePolicy, policyCommitment, policyToJson, proofState, releaseFacts, type Policy, type ProofState, type ReleaseFacts, type TimeRestriction, type Weekday, WEEKDAYS } from "@squaresdk/policy";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { createSquareClient } from "@squaresdk/core";
import { parseUsdc } from "./format";
import { activeChain, deployment, publicClient } from "./wagmi";

/**
 * The institution's side of the gate, in the browser (square#338, square#335).
 *
 * The policy file is the secret; here it lives in this browser's localStorage
 * under the wallet that owns it, and nowhere else. The page can commit it,
 * export it for the CLI and the hosted agent, approve buyers from it, and,
 * with a prover configured, bind a proof to a job. What reaches the chain is
 * the commitment, the buyer list's root and the proof bytes.
 */
const chainId = activeChain.id;
const readOnlyClient = createSquareClient({ publicClient, deployment });
export const ZERO32 = `0x${"0".repeat(64)}` as const;

/** The prover the browser may send the policy's secret to; unset means proofs are bound elsewhere (the CLI, the MCP server, the hosted agent). */
export const PROVER_URL: string | null = (process.env.NEXT_PUBLIC_PROVER_URL ?? "").trim().replace(/\/+$/, "") || null;

const policyKey = (owner: Address) => `square.policy.${chainId}.${owner.toLowerCase()}`;
const buyersKey = (owner: Address) => `square.buyers.${chainId}.${owner.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredPolicy(owner: Address): Policy | null {
  const raw = storage()?.getItem(policyKey(owner));
  if (!raw) return null;
  try {
    return parsePolicy(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function storePolicy(owner: Address, policy: Policy): void {
  storage()?.setItem(policyKey(owner), policyToJson(policy));
}

export function forgetPolicy(owner: Address): void {
  storage()?.removeItem(policyKey(owner));
}

export interface StoredBuyers {
  root: Hex;
  entries: BuyerEntry[];
}

export function readStoredBuyers(owner: Address): StoredBuyers | null {
  const raw = storage()?.getItem(buyersKey(owner));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredBuyers;
    const list = buyerListFrom(parsed.entries);
    return { root: list.root, entries: list.entries.map((e) => ({ ...e })) };
  } catch {
    return null;
  }
}

export function storeBuyers(owner: Address, list: BuyerList): void {
  storage()?.setItem(buyersKey(owner), JSON.stringify({ root: list.root, entries: list.entries }));
}

export function forgetBuyers(owner: Address): void {
  storage()?.removeItem(buyersKey(owner));
}

/** A stored value read on the client after mount, so the server render and the first client render agree. */
export function useStored<T>(owner: Address | undefined, read: (owner: Address) => T | null): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const refresh = useCallback(() => setValue(owner === undefined ? null : read(owner)), [owner, read]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return [value, refresh];
}

// ---------------------------------------------------------------- the form

export interface PolicyForm {
  daily: string;
  perTx: string;
  /** Comma or newline separated capability ids. */
  categories: string;
  /** Comma or newline separated addresses; the chain's USDC when empty. */
  tokens: string;
  /** Comma or newline separated addresses; none when empty. */
  blocked: string;
  windowOn: boolean;
  days: Weekday[];
  hoursStart: string;
  hoursEnd: string;
}

export const EMPTY_FORM: PolicyForm = { daily: "", perTx: "", categories: "", tokens: "", blocked: "", windowOn: false, days: [], hoursStart: "9", hoursEnd: "17" };

export type PolicyFormResult = { kind: "policy"; policy: Policy } | { kind: "invalid"; errors: Partial<Record<keyof PolicyForm, string>> };

const list = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The policy a filled form describes, for `operator`, with every error named by field; a policy comes back only when there is none. */
export function policyFromForm(form: PolicyForm, operator: Address, usdc: Address): PolicyFormResult {
  const errors: Partial<Record<keyof PolicyForm, string>> = {};
  const daily = parseUsdc(form.daily);
  const perTx = parseUsdc(form.perTx);
  if (daily === null || daily <= 0n) errors.daily = "Decimal USDC, above zero.";
  if (perTx === null || perTx <= 0n) errors.perTx = "Decimal USDC, above zero.";
  if (daily !== null && perTx !== null && perTx > daily) errors.perTx = "A release cannot be allowed more than the day.";
  const categories = list(form.categories);
  if (categories.length === 0) errors.categories = "At least one capability the policy pays for.";
  if (categories.length > 8) errors.categories = "At most eight.";
  if (categories.some((c) => new TextEncoder().encode(c).length > 32)) errors.categories = "Each at most 32 bytes.";
  const tokens = list(form.tokens);
  const blocked = list(form.blocked);
  const badToken = tokens.find((t) => !isAddress(t));
  if (badToken !== undefined) errors.tokens = `${badToken} is not an address.`;
  if (tokens.length > 10) errors.tokens = "At most ten.";
  const badBlocked = blocked.find((b) => !isAddress(b));
  if (badBlocked !== undefined) errors.blocked = `${badBlocked} is not an address.`;
  if (blocked.length > 10) errors.blocked = "At most ten.";
  let timeRestriction: TimeRestriction | undefined;
  if (form.windowOn) {
    const start = Number(form.hoursStart);
    const end = Number(form.hoursEnd);
    if (form.days.length === 0) errors.days = "Pick at least one weekday.";
    if (!Number.isInteger(start) || start < 0 || start > 23) errors.hoursStart = "An hour, 0 to 23.";
    if (!Number.isInteger(end) || end < 0 || end > 23) errors.hoursEnd = "An hour, 0 to 23.";
    if (Object.keys(errors).length === 0) timeRestriction = { allowed_days: form.days.filter((d) => WEEKDAYS.includes(d)), allowed_hours_start: start, allowed_hours_end: end };
  }
  if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
  try {
    return {
      kind: "policy",
      policy: newPolicy({
        operator,
        maxDailySpend: daily!,
        maxPerTransaction: perTx!,
        categories,
        tokens: tokens.length > 0 ? tokens.map((t) => getAddress(t)) : [usdc],
        blocked: blocked.map((b) => getAddress(b)),
        timeRestriction,
      }),
    };
  } catch (error) {
    return { kind: "invalid", errors: { categories: error instanceof Error ? error.message : String(error) } };
  }
}

/** A pasted policy file, for this wallet only: the secret in it belongs to the operator it names. */
export function policyFromPaste(text: string, operator: Address): { kind: "policy"; policy: Policy } | { kind: "invalid"; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "Not JSON." };
  }
  try {
    const policy = parsePolicy(json);
    if (policy.operator_id.toLowerCase() !== operator.toLowerCase()) return { kind: "invalid", message: `This policy is ${policy.operator_id}'s; the connected wallet is ${operator}.` };
    return { kind: "policy", policy };
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The addresses a buyer list textarea names, or the first thing wrong with them. */
export function buyersFromText(text: string): { kind: "buyers"; buyers: Address[] } | { kind: "invalid"; message: string } {
  const entries = list(text);
  if (entries.length === 0) return { kind: "invalid", message: "At least one address." };
  const bad = entries.find((e) => !isAddress(e));
  if (bad !== undefined) return { kind: "invalid", message: `${bad} is not an address.` };
  const buyers = entries.map((e) => getAddress(e));
  if (new Set(buyers).size !== buyers.length) return { kind: "invalid", message: "An address is listed twice." };
  return { kind: "buyers", buyers };
}

/** What the poster hands a buyer: the entry the purchase form on the job page takes. */
export function entryFor(list: BuyerList, buyer: Address): string {
  const eligibility = list.eligibilityOf(buyer);
  return JSON.stringify({ buyer, salt: eligibility.salt, proof: eligibility.proof }, null, 2);
}

export { approveBuyers, policyCommitment };

// --------------------------------------------------------------- chain reads

export interface PolicyOnChain {
  commitment: Hex;
  committed: boolean;
  dailyLimit: bigint;
  spentToday: bigint;
  remaining: bigint;
  epoch: bigint;
  updatedAt: bigint;
  buyerRoot: Hex;
  module: Address | null;
  tolerance: bigint | null;
}

export function usePolicyOnChain(owner: Address | undefined) {
  return useQuery({
    queryKey: ["policy", chainId, owner ?? null],
    enabled: owner !== undefined,
    refetchInterval: 10_000,
    queryFn: async (): Promise<PolicyOnChain> => {
      const who = owner!;
      const [policy, spent, buyerRoot, module, tolerance] = await Promise.all([
        readOnlyClient.policyOf(who),
        readOnlyClient.spentToday(who),
        readOnlyClient.buyerRootOf(who),
        readOnlyClient.complianceModule(),
        readOnlyClient.complianceTolerance(),
      ]);
      return {
        commitment: policy.commitment,
        committed: policy.commitment !== ZERO32,
        dailyLimit: policy.dailyLimit,
        spentToday: spent,
        remaining: policy.dailyLimit > spent ? policy.dailyLimit - spent : 0n,
        epoch: policy.epoch,
        updatedAt: policy.updatedAt,
        buyerRoot,
        module,
        tolerance,
      };
    },
  });
}

export interface JobCompliance {
  /** Null when no module is installed: the release is not proof gated. */
  module: Address | null;
  tolerance: bigint | null;
  bound: Hex;
  facts: ReleaseFacts | null;
  state: ProofState | null;
}

/** Where a Funded or Submitted job stands with the gate; nothing for other statuses. */
export function useJobCompliance(jobId: bigint | null, status: number | undefined) {
  const gated = status === JobStatus.Funded || status === JobStatus.Submitted;
  return useQuery({
    queryKey: ["compliance", chainId, jobId?.toString() ?? null, status ?? null],
    enabled: jobId !== null && gated,
    refetchInterval: 10_000,
    queryFn: async (): Promise<JobCompliance> => {
      const id = jobId!;
      const [module, tolerance, bound] = await Promise.all([readOnlyClient.complianceModule(), readOnlyClient.complianceTolerance(), readOnlyClient.complianceProofOf(id)]);
      if (module === null || tolerance === null) return { module: null, tolerance: null, bound, facts: null, state: null };
      const facts = await releaseFacts(readOnlyClient, id);
      return { module, tolerance, bound, facts, state: proofState(bound, facts, tolerance / 2n) };
    },
  });
}
