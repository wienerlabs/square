"use client";

import { JobStatus } from "@squaresdk/core";
import { bindComplianceProof, createProverClient, type Policy } from "@squaresdk/policy";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Address } from "viem";
import { AddressLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { Chip } from "@/components/Chip";
import { Field, inputClass } from "@/components/Field";
import { PanelCard } from "@/components/PanelCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { formatCountdown, shortHash } from "@/lib/format";
import { PROVER_URL, readStoredPolicy, useJobCompliance, useStored } from "@/lib/policy";
import { useSquare } from "@/lib/square";
import { describeError, useTx } from "@/lib/tx";

/**
 * Where a job stands with the compliance gate (square#335): whether the
 * hook holds a module, what proof the job carries, and whether that proof
 * still describes the release the chain would make now. The client binds
 * one from here when this browser holds its policy and a prover is
 * configured; otherwise the CLI, the MCP server or the hosted agent does.
 */
export function CompliancePanel({ jobId, status, client, address, now }: { jobId: bigint; status: number; client: Address; address: Address | undefined; now: number }) {
  const compliance = useJobCompliance(jobId, status);
  const isClient = address !== undefined && address.toLowerCase() === client.toLowerCase();
  const [policy] = useStored(isClient ? address : undefined, readStoredPolicy);
  if (status !== JobStatus.Funded && status !== JobStatus.Submitted) return null;
  if (compliance.isPending) return null;
  if (compliance.isError) return <PanelCard title="Compliance" description="The gate could not be read."><p className="text-caption text-magenta">{describeError(compliance.error)}</p></PanelCard>;
  const data = compliance.data;
  if (!data || data.module === null || data.facts === null || data.state === null) {
    return (
      <PanelCard title="Compliance" description="Read from the deployed hook right now.">
        <p className="text-caption text-graphite">The compliance slot is empty, so this release is not proof gated: finalize pays the payee whatever proof the job carries.</p>
      </PanelCard>
    );
  }
  const { facts, state, tolerance } = data;
  return (
    <PanelCard
      title="Compliance"
      description="The hook holds a module: at release it hands the proof bound to this job to the module, which checks it against the client's commitment, the payee, the net, today's counter and the clock. A release without a current proof pays the client back."
    >
      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Bound proof</dt>
          <dd className="text-body text-carbon">
            {state.kind === "none" ? <Chip dot="amber">None bound</Chip> : state.kind === "malformed" ? <Chip dot="magenta">Malformed</Chip> : state.kind === "current" ? <Chip dot="mint">Current, {state.age.toString()} s old</Chip> : <Chip dot="amber">Stale</Chip>}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Would pay</dt>
          <dd className="text-body text-carbon">
            <AddressLink address={facts.payee} /> <AmountUsdc value={facts.amount} />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Counter today</dt>
          <dd className="text-body text-carbon">
            <AmountUsdc value={facts.dailySpentBefore} />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Module</dt>
          <dd className="text-body text-carbon">
            <AddressLink address={data.module} /> <span className="text-caption text-graphite">tolerance {tolerance?.toString() ?? "?"} s</span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Window</dt>
          <dd className="text-body text-carbon">{facts.challengeEnd === null ? "not submitted yet" : facts.challengeEnd <= facts.now ? "closed" : `closes in ${formatCountdown(Number(facts.challengeEnd), now)}`}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-ash">Commitment</dt>
          <dd className="text-body text-carbon">
            {facts.commitment === `0x${"0".repeat(64)}` ? <Chip dot="amber">Client committed no policy</Chip> : <span className="font-mono text-[13px]" title={facts.commitment}>{shortHash(facts.commitment)}</span>}
          </dd>
        </div>
      </dl>
      {state.kind === "stale" ? (
        <ul className="mt-4 list-disc pl-5 text-caption text-graphite">
          {state.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {isClient ? <BindProof jobId={jobId} policy={policy} stateKind={state.kind} /> : null}
    </PanelCard>
  );
}

function BindProof({ jobId, policy, stateKind }: { jobId: bigint; policy: Policy | null; stateKind: string }) {
  const square = useSquare();
  const { notify, busy } = useTx();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  if (policy === null) {
    return <p className="mt-4 text-caption text-graphite">This browser holds no policy for the client; write or paste it on the Policy page, or bind proofs with square policy prove, the MCP server or the hosted agent.</p>;
  }
  if (PROVER_URL === null) {
    return <p className="mt-4 text-caption text-graphite">No prover is configured for this page (NEXT_PUBLIC_PROVER_URL), so proofs are bound elsewhere: square policy prove, the MCP server or the hosted agent.</p>;
  }
  const categories = policy.allowed_endpoint_categories;
  const chosen = category || categories[0] || "";
  const proverUrl = PROVER_URL;
  const bind = async () => {
    notify({ status: "pending", label: "Bind proof" });
    setOutcome(null);
    try {
      const result = await bindComplianceProof({ client: square, policy, prover: createProverClient({ url: proverUrl }), jobId, category: chosen });
      if (result.bound) {
        notify({ status: "success", label: "Bind proof", hash: result.transaction });
        setOutcome(`Proof bound: payee ${result.facts.payee}, net ${result.facts.amount.toString()} atomic units.`);
      } else {
        const message = result.reason === "not-compliant" ? `The policy does not allow this release: ${(result.violated ?? ["rules unknown"]).join(", ")}.` : result.detail;
        notify({ status: "error", label: "Bind proof", message });
        setOutcome(message);
      }
      await queryClient.invalidateQueries();
    } catch (error) {
      notify({ status: "error", label: "Bind proof", message: describeError(error) });
    }
  };
  return (
    <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-fog p-5">
      <div>
        <h3 className="text-body font-medium text-carbon">{stateKind === "current" ? "Rebind the proof" : "Bind a proof"}</h3>
        <p className="mt-1 text-caption text-graphite">Asks the prover at {PROVER_URL} for a proof that this release fits your policy as it stands now, and binds it to the job. Rebind when the payee, the net or today's counter move, or before the tolerance runs out.</p>
      </div>
      <Field label="Capability the job bought" htmlFor="proof-category" hint="One of the policy's capabilities.">
        <select id="proof-category" className={inputClass} value={chosen} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton size="sm" disabled={busy || chosen === ""} onClick={() => void bind()}>
          {stateKind === "current" ? "Rebind" : "Bind proof"}
        </PrimaryButton>
        {outcome ? <span className="text-caption text-graphite">{outcome}</span> : null}
      </div>
    </div>
  );
}
