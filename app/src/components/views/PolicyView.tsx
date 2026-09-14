"use client";

import { policyToJson, redactPolicy, WEEKDAYS, type Policy, type Weekday } from "@squaresdk/policy";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount } from "wagmi";
import { AddressLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { Field, inputClass } from "@/components/Field";
import { GhostButton } from "@/components/GhostButton";
import { PanelCard } from "@/components/PanelCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SectionHeading } from "@/components/SectionHeading";
import { WalletButton } from "@/components/WalletButton";
import { formatTimestamp, formatUsdc, shortHash } from "@/lib/format";
import {
  approveBuyers,
  buyersFromText,
  EMPTY_FORM,
  entryFor,
  forgetBuyers,
  forgetPolicy,
  policyCommitment,
  policyFromForm,
  policyFromPaste,
  PROVER_URL,
  readStoredBuyers,
  readStoredPolicy,
  storeBuyers,
  storePolicy,
  usePolicyOnChain,
  useStored,
  ZERO32,
  type PolicyForm,
} from "@/lib/policy";
import { useSquare } from "@/lib/square";
import { useTx } from "@/lib/tx";
import { activeChain, deployment } from "@/lib/wagmi";
import { buyerListFrom } from "@squaresdk/core";

/**
 * The institution's page: the policy it commits and the buyers it approves
 * (square#338). The policy is written here, kept in this browser under the
 * wallet, and its commitment goes on chain; the same file drives the CLI,
 * the MCP server and the hosted agent, so it can be copied out. Proofs for
 * releases are bound from the job page, or by those tools.
 */
export function PolicyView() {
  const { address, chainId } = useAccount();
  const onChain = usePolicyOnChain(address);
  const [stored, refreshStored] = useStored(address, readStoredPolicy);
  const [buyers, refreshBuyers] = useStored(address, readStoredBuyers);
  const canSend = address !== undefined && chainId === activeChain.id;
  const reason = address === undefined ? "Connect a wallet to send." : chainId !== activeChain.id ? `Switch the wallet to ${activeChain.name}.` : null;

  if (address === undefined) {
    return (
      <>
        <SectionHeading title="Policy" description="The spending mandate an institution commits on chain, and the buyers its receivables may be sold to." />
        <EmptyState title="Connect the institution's wallet" hint="The policy is committed by the wallet that hires; connect it to read and write its policy." action={<WalletButton />} />
      </>
    );
  }

  return (
    <>
      <SectionHeading
        title="Policy"
        description={`The spending mandate ${address} commits on chain, and the buyers its receivables may be sold to. The commitment is what a release has to prove it fits; the mandate itself stays here.`}
      />
      <div className="flex flex-col gap-6">
        <OnChainCard address={address} onChain={onChain.data} loading={onChain.isPending} error={onChain.isError ? String(onChain.error) : null} />
        <PolicyCard address={address} stored={stored} refresh={refreshStored} commitmentOnChain={onChain.data?.commitment ?? null} canSend={canSend} reason={reason} />
        <BuyersCard address={address} stored={buyers} refresh={refreshBuyers} rootOnChain={onChain.data?.buyerRoot ?? null} canSend={canSend} reason={reason} />
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-ash">{label}</dt>
      <dd className="text-body text-carbon">{children}</dd>
    </div>
  );
}

function OnChainCard({ address, onChain, loading, error }: { address: Address; onChain: ReturnType<typeof usePolicyOnChain>["data"]; loading: boolean; error: string | null }) {
  return (
    <PanelCard title="On chain" description={`What PolicyRegistry holds for ${address}, and whether the hook's slot holds a module.`}>
      {loading ? <p className="text-caption text-graphite">Reading the registry…</p> : null}
      {error ? <p className="text-caption text-magenta">{error}</p> : null}
      {onChain ? (
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Commitment">{onChain.committed ? <span className="font-mono text-[13px]" title={onChain.commitment}>{shortHash(onChain.commitment)}</span> : <Chip dot="ash">No policy committed</Chip>}</Row>
          <Row label="Daily limit">{onChain.committed ? <AmountUsdc value={onChain.dailyLimit} /> : "n/a"}</Row>
          <Row label="Spent today">
            {onChain.committed ? (
              <span>
                <AmountUsdc value={onChain.spentToday} /> <span className="text-caption text-graphite">({formatUsdc(onChain.remaining)} USDC left)</span>
              </span>
            ) : (
              "n/a"
            )}
          </Row>
          <Row label="Epoch">{onChain.committed ? `${onChain.epoch.toString()}, since ${formatTimestamp(Number(onChain.updatedAt))}` : "n/a"}</Row>
          <Row label="Buyer list">{onChain.buyerRoot === ZERO32 ? <Chip dot="ash">Nobody approved</Chip> : <span className="font-mono text-[13px]" title={onChain.buyerRoot}>{shortHash(onChain.buyerRoot)}</span>}</Row>
          <Row label="Gate">
            {onChain.module === null ? (
              <Chip dot="ash">Slot empty: releases are not proof gated</Chip>
            ) : (
              <span>
                <Chip dot="mint">Module installed</Chip> <AddressLink address={onChain.module} />
                {onChain.tolerance !== null ? <span className="text-caption text-graphite"> · tolerance {onChain.tolerance.toString()} s</span> : null}
              </span>
            )}
          </Row>
        </dl>
      ) : null}
    </PanelCard>
  );
}

function PolicyCard({ address, stored, refresh, commitmentOnChain, canSend, reason }: { address: Address; stored: Policy | null; refresh: () => void; commitmentOnChain: Hex | null; canSend: boolean; reason: string | null }) {
  const square = useSquare();
  const { run, busy } = useTx();
  const [form, setForm] = useState<PolicyForm>({ ...EMPTY_FORM, tokens: deployment.usdc });
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyForm, string>>>({});
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [commitment, setCommitment] = useState<Hex | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCommitment(null);
    if (stored) void policyCommitment(stored).then((c) => (cancelled ? undefined : setCommitment(c.hex)));
    return () => {
      cancelled = true;
    };
  }, [stored]);

  const committed = commitment !== null && commitmentOnChain !== null && commitment.toLowerCase() === commitmentOnChain.toLowerCase();
  const set = (key: keyof PolicyForm, value: string | boolean | Weekday[]) => setForm((f) => ({ ...f, [key]: value }));

  const create = () => {
    const result = policyFromForm(form, address, deployment.usdc);
    if (result.kind === "invalid") {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    storePolicy(address, result.policy);
    refresh();
  };
  const importPasted = () => {
    const result = policyFromPaste(paste, address);
    if (result.kind === "invalid") {
      setPasteError(result.message);
      return;
    }
    setPasteError(null);
    setPaste("");
    storePolicy(address, result.policy);
    refresh();
  };
  const copy = async () => {
    if (!stored) return;
    await navigator.clipboard.writeText(policyToJson(stored));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (stored) {
    const window = stored.time_restrictions?.[0];
    return (
      <PanelCard
        title="Your policy"
        description="Kept in this browser under the connected wallet, secret included. Copy it out for square policy, the MCP server or the hosted agent; forgetting it here does not touch the chain."
        actions={
          <div className="flex flex-wrap gap-2">
            <GhostButton size="sm" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy JSON"}
            </GhostButton>
            <GhostButton
              size="sm"
              onClick={() => {
                forgetPolicy(address);
                refresh();
              }}
            >
              Forget
            </GhostButton>
          </div>
        }
      >
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Policy id">
            <span className="font-mono text-[13px]">{stored.policy_id}</span>
          </Row>
          <Row label="Daily ceiling">
            <AmountUsdc value={BigInt(stored.max_daily_spend)} />
          </Row>
          <Row label="Per release">
            <AmountUsdc value={BigInt(stored.max_per_transaction)} />
          </Row>
          <Row label="Capabilities">{stored.allowed_endpoint_categories.join(", ")}</Row>
          <Row label="Tokens">
            <span className="flex flex-col gap-1">
              {stored.token_whitelist.map((t) => (
                <AddressLink key={t} address={t} />
              ))}
            </span>
          </Row>
          <Row label="Blocked payees">
            {stored.blocked_addresses.length === 0 ? (
              "none"
            ) : (
              <span className="flex flex-col gap-1">
                {stored.blocked_addresses.map((b) => (
                  <AddressLink key={b} address={b} />
                ))}
              </span>
            )}
          </Row>
          <Row label="Window">{window ? `${window.allowed_days.join(", ")}, ${window.allowed_hours_start}:00 to ${window.allowed_hours_end}:00 UTC` : "any time"}</Row>
          <Row label="Commitment">
            {commitment === null ? "computing…" : <span className="font-mono text-[13px]" title={commitment}>{shortHash(commitment)}</span>}
          </Row>
          <Row label="Status">{commitment === null ? "…" : committed ? <Chip dot="mint">Committed on chain</Chip> : commitmentOnChain === ZERO32 || commitmentOnChain === null ? <Chip dot="amber">Not committed yet</Chip> : <Chip dot="amber">The chain holds a different commitment</Chip>}</Row>
        </dl>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <PrimaryButton
            size="sm"
            disabled={busy || !canSend || commitment === null || committed}
            onClick={() => {
              if (commitment === null) return;
              void run("Commit policy", () => square.setPolicy(commitment, BigInt(stored.max_daily_spend)));
            }}
          >
            {committed ? "Committed" : "Commit on chain"}
          </PrimaryButton>
          <span className="text-caption text-ash">{reason ?? "setPolicy(commitment, daily limit); every commit starts a new epoch."}</span>
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-caption text-graphite">The file, redacted</summary>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-mist p-4 font-mono text-[12px] text-carbon">{JSON.stringify(redactPolicy(stored), null, 2)}</pre>
        </details>
      </PanelCard>
    );
  }

  return (
    <PanelCard title="Write a policy" description="A fresh id and a fresh secret salt are drawn here; the policy is kept in this browser under the connected wallet until you forget it.">
      <form
        className="grid gap-5 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <Field label="Daily ceiling (USDC)" htmlFor="policy-daily" error={errors.daily ?? null} hint="What all releases of one UTC day may add up to; published on chain as the daily limit.">
          <input id="policy-daily" inputMode="decimal" className={inputClass} value={form.daily} onChange={(e) => set("daily", e.target.value)} placeholder="100.00" />
        </Field>
        <Field label="Per release (USDC)" htmlFor="policy-pertx" error={errors.perTx ?? null} hint="The most one release may pay.">
          <input id="policy-pertx" inputMode="decimal" className={inputClass} value={form.perTx} onChange={(e) => set("perTx", e.target.value)} placeholder="10.00" />
        </Field>
        <Field label="Capabilities" htmlFor="policy-categories" error={errors.categories ?? null} hint="The capability ids this policy pays for, comma separated; a release names the one it bought. At most eight.">
          <input id="policy-categories" className={`${inputClass} font-mono text-[13px]`} value={form.categories} onChange={(e) => set("categories", e.target.value)} placeholder="text.summarize, research.brief" />
        </Field>
        <Field label="Tokens" htmlFor="policy-tokens" error={errors.tokens ?? null} hint="Tokens a release may pay in. The chain's USDC by default.">
          <input id="policy-tokens" className={`${inputClass} font-mono text-[13px]`} value={form.tokens} onChange={(e) => set("tokens", e.target.value)} />
        </Field>
        <Field label="Blocked payees" htmlFor="policy-blocked" error={errors.blocked ?? null} hint="Addresses the policy refuses to pay, comma separated. Optional, at most ten.">
          <input id="policy-blocked" className={`${inputClass} font-mono text-[13px]`} value={form.blocked} onChange={(e) => set("blocked", e.target.value)} placeholder="0x…" />
        </Field>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-caption text-graphite">
            <input type="checkbox" checked={form.windowOn} onChange={(e) => set("windowOn", e.target.checked)} />
            Only release inside a weekly window (UTC)
          </label>
          {form.windowOn ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((day) => {
                  const on = form.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => set("days", on ? form.days.filter((d) => d !== day) : [...form.days, day])}
                      className={`rounded-full border px-3 py-1 text-caption ${on ? "border-carbon bg-carbon text-paper-white" : "border-fog text-graphite"}`}
                    >
                      {day.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
              {errors.days ? <p className="text-caption text-magenta">{errors.days}</p> : null}
              <div className="grid grid-cols-2 gap-3">
                <Field label="From hour" htmlFor="policy-start" error={errors.hoursStart ?? null}>
                  <input id="policy-start" inputMode="numeric" className={inputClass} value={form.hoursStart} onChange={(e) => set("hoursStart", e.target.value)} />
                </Field>
                <Field label="To hour" htmlFor="policy-end" error={errors.hoursEnd ?? null}>
                  <input id="policy-end" inputMode="numeric" className={inputClass} value={form.hoursEnd} onChange={(e) => set("hoursEnd", e.target.value)} />
                </Field>
              </div>
            </div>
          ) : null}
        </div>
        <div className="md:col-span-2">
          <PrimaryButton size="sm" type="submit">
            Create the policy
          </PrimaryButton>
        </div>
      </form>
      <details className="mt-6">
        <summary className="cursor-pointer text-caption text-graphite">Have a policy file already? Paste it</summary>
        <div className="mt-3 flex flex-col gap-3">
          <textarea className={`${inputClass} min-h-32 font-mono text-[12px]`} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"policy_id": "…", "policy_salt": "…", …}' />
          {pasteError ? <p className="text-caption text-magenta">{pasteError}</p> : null}
          <div>
            <GhostButton size="sm" onClick={importPasted}>
              Use this file
            </GhostButton>
          </div>
        </div>
      </details>
    </PanelCard>
  );
}

function BuyersCard({ address, stored, refresh, rootOnChain, canSend, reason }: { address: Address; stored: { root: Hex; entries: { buyer: Address; salt: Hex }[] } | null; refresh: () => void; rootOnChain: Hex | null; canSend: boolean; reason: string | null }) {
  const square = useSquare();
  const { run, busy } = useTx();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<Address | null>(null);
  const list = useMemo(() => (stored ? buyerListFrom(stored.entries) : null), [stored]);
  const published = list !== null && rootOnChain !== null && list.root.toLowerCase() === rootOnChain.toLowerCase();

  const publish = () => {
    const parsed = buyersFromText(text);
    if (parsed.kind === "invalid") {
      setError(parsed.message);
      return;
    }
    setError(null);
    const next = approveBuyers(parsed.buyers);
    void run("Publish buyer list", () => square.setBuyerRoot(next.root)).then((result) => {
      if (!result) return;
      storeBuyers(address, next);
      setText("");
      refresh();
    });
  };
  const copyEntry = async (buyer: Address) => {
    if (!list) return;
    await navigator.clipboard.writeText(entryFor(list, buyer));
    setCopied(buyer);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <PanelCard
      title="Approved buyers"
      description="Who this wallet's receivables may be sold to. Only the list's root goes on chain; each buyer's salt and path are issued from here and pasted into the purchase."
    >
      {list && stored ? (
        <div className="mb-6 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-caption text-graphite">
            <span className="font-mono text-[13px] text-carbon" title={list.root}>
              root {shortHash(list.root)}
            </span>
            {published ? <Chip dot="mint">Published</Chip> : <Chip dot="amber">Not the list on chain</Chip>}
            <GhostButton
              size="sm"
              onClick={() => {
                forgetBuyers(address);
                refresh();
              }}
            >
              Forget entries
            </GhostButton>
          </div>
          <ul className="flex flex-col gap-2">
            {stored.entries.map((entry) => (
              <li key={entry.buyer} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-fog px-4 py-2">
                <AddressLink address={entry.buyer} full />
                <GhostButton size="sm" onClick={() => void copyEntry(entry.buyer)}>
                  {copied === entry.buyer ? "Copied" : "Copy entry"}
                </GhostButton>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mb-4 text-caption text-graphite">No entries kept in this browser{rootOnChain !== null && rootOnChain !== ZERO32 ? "; the chain holds a root published elsewhere" : ""}.</p>
      )}
      <Field label={list ? "Replace the list" : "Approve buyers"} htmlFor="buyers-text" error={error} hint="Addresses, one per line or comma separated. Publishing replaces the list on chain; every buyer gets a fresh salt.">
        <textarea id="buyers-text" className={`${inputClass} min-h-24 font-mono text-[13px]`} value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" />
      </Field>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton size="sm" disabled={busy || !canSend} onClick={publish}>
          Publish the list
        </PrimaryButton>
        <span className="text-caption text-ash">{reason ?? "setBuyerRoot(root); the entries stay here."}</span>
      </div>
      {PROVER_URL === null ? null : <p className="mt-4 text-caption text-graphite">Proofs are bound from each job's page, at {PROVER_URL}.</p>}
    </PanelCard>
  );
}
