"use client";

import { specDescription } from "@squaresdk/core";
import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, type Hex } from "viem";
import { useAccount } from "wagmi";
import { AddressLink, TxLink } from "@/components/AddressLink";
import { Field, inputClass } from "@/components/Field";
import { GhostButton } from "@/components/GhostButton";
import { PanelCard } from "@/components/PanelCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SectionHeading } from "@/components/SectionHeading";
import { formatDuration, formatTimestamp, fromDatetimeLocal, parseUsdc, toDatetimeLocal } from "@/lib/format";
import { useNetwork, useNow, useSquare } from "@/lib/square";
import { describeError, useTx } from "@/lib/tx";
import { activeChain, deployment } from "@/lib/wagmi";

type SpecState =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ok"; value: unknown; description: string };

function parseSpec(source: string): SpecState {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  try {
    const value: unknown = JSON.parse(trimmed);
    return { kind: "ok", value, description: specDescription(value) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

interface Created {
  jobId: bigint;
  createHash: Hex;
  budgetHash?: Hex;
  budgetFailed: boolean;
}

export function NewJobView() {
  const network = useNetwork();
  const now = useNow(10_000);
  const square = useSquare();
  const { run, busy } = useTx();
  const { address, chainId } = useAccount();

  const [provider, setProvider] = useState("");
  const [expiry, setExpiry] = useState("");
  const [spec, setSpec] = useState("");
  const [budget, setBudget] = useState("");
  const [created, setCreated] = useState<Created | null>(null);

  const horizon = network.data?.settlementHorizon;
  const minExpiry = horizon === undefined ? null : now + horizon;

  useEffect(() => {
    if (horizon === undefined) return;
    setExpiry((current) => (current.length === 0 ? toDatetimeLocal(Math.floor(Date.now() / 1000) + horizon + 86_400) : current));
  }, [horizon]);

  const specState = useMemo(() => parseSpec(spec), [spec]);
  const providerError = provider.length === 0 || isAddress(provider) ? null : "Enter a 0x address.";
  const expirySeconds = fromDatetimeLocal(expiry);
  const expiryError =
    expiry.length === 0
      ? null
      : expirySeconds === null
        ? "Enter a date and time."
        : minExpiry !== null && expirySeconds < minExpiry
          ? `The expiry must be at least ${formatDuration(horizon ?? 0)} from now.`
          : null;
  const budgetAmount = budget.trim().length === 0 ? null : parseUsdc(budget);
  const budgetError = budget.trim().length > 0 && budgetAmount === null ? "Enter an amount with up to six decimals." : null;
  const onActiveChain = address !== undefined && chainId === activeChain.id;
  const ready =
    isAddress(provider) && expirySeconds !== null && expiryError === null && specState.kind === "ok" && budgetError === null && onActiveChain && !busy;

  async function submit() {
    if (!ready || expirySeconds === null || specState.kind !== "ok") return;
    const result = await run("Create job", () =>
      square.createJob({ provider: getAddress(provider), expiredAt: BigInt(expirySeconds), spec: specState.value }),
    );
    if (!result) return;
    let budgetHash: Hex | undefined;
    let budgetFailed = false;
    if (budgetAmount !== null && budgetAmount > 0n) {
      const set = await run("Set budget", () => square.setBudget(result.jobId, budgetAmount));
      if (set) budgetHash = set.hash;
      else budgetFailed = true;
    }
    setCreated({ jobId: result.jobId, createHash: result.hash, budgetHash, budgetFailed });
  }

  return (
    <div className="flex flex-col gap-16">
      <SectionHeading
        title="New job"
        description="Opens a job on SquareJob with the keeper evaluator and the Square hook bound at creation."
      />

      {created ? (
        <PanelCard elevated title={`Job #${created.jobId.toString()} created`} description="Both receipts are linked to the explorer.">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt className="text-caption text-graphite">createJob</dt>
              <dd className="mt-1 text-body">
                <TxLink hash={created.createHash} />
              </dd>
            </div>
            <div>
              <dt className="text-caption text-graphite">setBudget</dt>
              <dd className="mt-1 text-body">
                {created.budgetHash ? (
                  <TxLink hash={created.budgetHash} />
                ) : created.budgetFailed ? (
                  <span className="text-magenta">Failed; set it from the job page.</span>
                ) : (
                  <span className="text-ash">Skipped</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-6 flex flex-wrap gap-3">
            <PrimaryButton href={`/job?id=${created.jobId.toString()}`}>Open job #{created.jobId.toString()}</PrimaryButton>
            <GhostButton onClick={() => setCreated(null)}>Create another</GhostButton>
          </div>
        </PanelCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <PanelCard title="Job">
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Provider address" htmlFor="provider" hint="The agent's wallet. It must be set before the job can be funded." error={providerError}>
              <input
                id="provider"
                className={inputClass}
                value={provider}
                onChange={(event) => setProvider(event.target.value.trim())}
                placeholder="0x"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Expiry"
              htmlFor="expiry"
              hint={
                minExpiry !== null && horizon !== undefined
                  ? `Minimum now plus the settlement horizon of ${formatDuration(horizon)}: ${formatTimestamp(minExpiry)}. Refunds open at expiry.`
                  : network.isError
                    ? `The settlement horizon could not be read: ${describeError(network.error)}`
                    : "Reading the settlement horizon from KeeperEvaluator."
              }
              error={expiryError}
            >
              <input
                id="expiry"
                type="datetime-local"
                className={inputClass}
                value={expiry}
                min={minExpiry !== null ? toDatetimeLocal(minExpiry) : undefined}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </Field>
            <Field
              label="Spec (JSON)"
              htmlFor="spec"
              hint={
                specState.kind === "ok" ? (
                  <span className="break-all tabular-nums">On-chain description {specState.description}</span>
                ) : (
                  "Canonicalized and hashed locally; the description stored on chain is spec: followed by the keccak256 hash."
                )
              }
              error={specState.kind === "error" ? `Invalid JSON: ${specState.message}` : null}
            >
              <textarea
                id="spec"
                rows={8}
                className={`${inputClass} font-[inherit]`}
                value={spec}
                onChange={(event) => setSpec(event.target.value)}
                placeholder={'{"task": "...", "acceptance": "..."}'}
                spellCheck={false}
              />
            </Field>
            <Field label="Budget (USDC, optional)" htmlFor="budget-amount" hint="Sent as a second transaction right after creation. Funding happens from the job page." error={budgetError}>
              <input id="budget-amount" inputMode="decimal" className={inputClass} value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="0.00" />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <PrimaryButton type="submit" disabled={!ready}>
                {busy ? "Sending" : "Create job"}
              </PrimaryButton>
              {address === undefined ? (
                <span className="text-caption text-ash">Connect a wallet to create a job.</span>
              ) : chainId !== activeChain.id ? (
                <span className="text-caption text-ash">Switch the wallet to {activeChain.name}.</span>
              ) : null}
            </div>
          </form>
        </PanelCard>

        <PanelCard title="Bound at creation" description="These come from the SDK's deployment table for this chain.">
          <dl className="flex flex-col gap-5">
            <div>
              <dt className="text-caption text-graphite">Evaluator</dt>
              <dd className="mt-1 text-body">
                <AddressLink address={deployment.keeperEvaluator} /> <span className="text-caption text-graphite">KeeperEvaluator</span>
              </dd>
            </div>
            <div>
              <dt className="text-caption text-graphite">Hook</dt>
              <dd className="mt-1 text-body">
                <AddressLink address={deployment.squareHook} /> <span className="text-caption text-graphite">SquareHook</span>
              </dd>
            </div>
            <div>
              <dt className="text-caption text-graphite">Payment token</dt>
              <dd className="mt-1 text-body">
                <AddressLink address={deployment.usdc} /> <span className="text-caption text-graphite">USDC, 6 decimals</span>
              </dd>
            </div>
            <div>
              <dt className="text-caption text-graphite">Settlement horizon</dt>
              <dd className="mt-1 text-body tabular-nums">
                {horizon !== undefined ? `${formatDuration(horizon)} (${horizon} s)` : network.isError ? "Unavailable" : "Loading"}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-graphite">Client</dt>
              <dd className="mt-1 text-body">{address ? <AddressLink address={address} /> : <span className="text-ash">No wallet connected</span>}</dd>
            </div>
          </dl>
        </PanelCard>
      </div>
    </div>
  );
}
