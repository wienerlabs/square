"use client";

import { specDescription } from "@squaresdk/core";
import canonicalize from "canonicalize";
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { useAccount } from "wagmi";
import { AddressLink, TxLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { Field, inputClass } from "@/components/Field";
import { JsonEditor } from "@/components/JsonEditor";
import { GhostButton } from "@/components/GhostButton";
import { PanelCard } from "@/components/PanelCard";
import { PillToggle } from "@/components/PillToggle";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SectionHeading } from "@/components/SectionHeading";
import { SpecActions } from "@/components/SpecActions";
import { Step, type StepState } from "@/components/Step";
import { ArcNetworkMark, UsdcMark } from "@/components/marks";
import { WalletButton } from "@/components/WalletButton";
import { minimumExpiry } from "@/lib/actions";
import { addressInputError, readAddressInput } from "@/lib/address";
import { formatBps, formatDuration, formatTimestamp, formatUsdc, fromDatetimeLocal, parseUsdc, shortAddress, shortHash, toDatetimeLocal } from "@/lib/format";
import { useNetwork, useNow, useSquare } from "@/lib/square";
import { describeError, useTx } from "@/lib/tx";
import { activeChain, deployment, isArcNetwork } from "@/lib/wagmi";

const DAY = 86_400;

const EXPIRY_PRESETS = [
  { id: "1d", label: "1 day", seconds: DAY },
  { id: "3d", label: "3 days", seconds: 3 * DAY },
  { id: "1w", label: "1 week", seconds: 7 * DAY },
  { id: "30d", label: "30 days", seconds: 30 * DAY },
] as const;

const BUDGET_PRESETS = ["10", "50", "100", "500"] as const;

const SPEC_TEMPLATES = [
  {
    id: "labelling",
    label: "Data labelling",
    spec: {
      task: "Label 500 product images with exactly one of: shoe, bag, jacket, other",
      input: "Zip of JPEG files, delivered by link before the job is funded",
      deliverable: "labels.jsonl with one {file, label} object per line",
      acceptance: "A spot check of 50 images agrees with the labels on at least 48",
    },
  },
  {
    id: "review",
    label: "Code review",
    spec: {
      task: "Review one pull request for correctness and security",
      input: "Repository and pull request number",
      deliverable: "Markdown report with findings ranked by severity, each naming a file and line",
      acceptance: "Every finding reproduces; no finding above medium is a false positive",
    },
  },
  {
    id: "brief",
    label: "Research brief",
    spec: {
      task: "Two page brief on the corporate tax filing calendar for a mainland UAE LLC",
      deliverable: "PDF with every date traced to a Federal Tax Authority publication",
      acceptance: "No date without a source; delivered before the expiry",
    },
  },
] as const;

type SpecState =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ok"; value: unknown; description: string; hash: string };

function parseSpec(source: string): SpecState {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  try {
    const value: unknown = JSON.parse(trimmed);
    const description = specDescription(value);
    return { kind: "ok", value, description, hash: description.replace(/^spec:/, "") };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message.replace(/^JSON\.parse: /, "") : "Invalid JSON" };
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface Created {
  jobId: bigint;
  createHash: Hex;
  budgetHash?: Hex;
  budgetFailed: boolean;
  budget: bigint | null;
  spec: string;
  specHash: string;
}

function Row({ label, children, muted = false }: { label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-fog py-3 last:border-b-0">
      <dt className="shrink-0 text-caption text-graphite">{label}</dt>
      <dd className={`min-w-0 text-right text-body tabular-nums ${muted ? "text-ash" : "text-carbon"}`}>{children}</dd>
    </div>
  );
}

function Check({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-caption">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${done ? "bg-mint" : "bg-fog"}`} />
      <span className={done ? "text-carbon" : "text-graphite"}>{children}</span>
      <span className="sr-only">{done ? "(done)" : "(pending)"}</span>
    </li>
  );
}

export function NewJobView() {
  const network = useNetwork();
  const now = useNow(10_000);
  const square = useSquare();
  const { run, busy, state: txState } = useTx();
  const { address, chainId } = useAccount();

  const [provider, setProvider] = useState("");
  const [expiry, setExpiry] = useState("");
  const [expiryPreset, setExpiryPreset] = useState<string | null>("1w");
  const [spec, setSpec] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [showCanonical, setShowCanonical] = useState(false);
  const [budget, setBudget] = useState("");
  const [stage, setStage] = useState<"create" | "budget" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    setExpiry((current) => (current.length === 0 ? toDatetimeLocal(Math.floor(Date.now() / 1000) + 7 * DAY) : current));
  }, []);

  const horizon = network.data?.settlementHorizon;
  const floor = horizon === undefined ? null : minimumExpiry(now, horizon);
  const minExpiry = floor === null ? null : floor.at;

  const specState = useMemo(() => parseSpec(spec), [spec]);
  const canonical = useMemo(() => (specState.kind === "ok" ? (canonicalize(specState.value) ?? "") : ""), [specState]);
  const providerInput = useMemo(() => readAddressInput(provider), [provider]);
  const providerValid = providerInput.kind === "valid";
  const providerError = addressInputError(providerInput);
  const expirySeconds = fromDatetimeLocal(expiry);
  const expiryError =
    expiry.length === 0
      ? null
      : expirySeconds === null
        ? "Enter a date and time."
        : floor !== null && expirySeconds < floor.at
          ? `The expiry must be at least ${formatDuration(floor.horizon + floor.margin)} from now: one settlement horizon of ${formatDuration(floor.horizon)} for the challenge and dispute windows, plus ${formatDuration(floor.margin)} of margin, because submit measures the same horizon again from its own block and a job created at the bare minimum can never be submitted.`
          : null;
  const expiryValid = expirySeconds !== null && expiryError === null;
  const budgetAmount = budget.trim().length === 0 ? null : parseUsdc(budget);
  const budgetError = budget.trim().length > 0 && budgetAmount === null ? "Enter an amount with up to six decimals." : null;
  const budgetValid = budgetError === null;
  const onActiveChain = address !== undefined && chainId === activeChain.id;
  const ready = providerValid && expiryValid && specState.kind === "ok" && budgetValid && onActiveChain && !busy;

  const fees =
    budgetAmount !== null && budgetAmount > 0n && network.data
      ? {
          platform: (budgetAmount * BigInt(network.data.platformFeeBP)) / 10_000n,
          evaluator: (budgetAmount * BigInt(network.data.evaluatorFeeBP)) / 10_000n,
        }
      : null;
  const net = fees && budgetAmount !== null ? budgetAmount - fees.platform - fees.evaluator : null;

  const providerState: StepState = providerValid ? "done" : providerError ? "error" : "todo";
  const expiryState: StepState = expiryValid ? "done" : expiryError ? "error" : "todo";
  const specStepState: StepState = specState.kind === "ok" ? "done" : specState.kind === "error" ? "error" : "todo";
  const budgetState: StepState = budgetAmount !== null && budgetAmount > 0n ? "done" : budgetError ? "error" : "todo";

  function chooseExpiry(id: string, seconds: number) {
    setExpiryPreset(id);
    setExpiry(toDatetimeLocal(Math.floor(Date.now() / 1000) + seconds));
  }

  function applyTemplate(id: string) {
    const found = SPEC_TEMPLATES.find((entry) => entry.id === id);
    if (!found) return;
    setTemplate(id);
    setSpec(JSON.stringify(found.spec, null, 2));
  }

  function formatSpec() {
    if (specState.kind !== "ok") return;
    setSpec(JSON.stringify(specState.value, null, 2));
  }

  function reset() {
    setCreated(null);
    setProvider("");
    setSpec("");
    setTemplate(null);
    setBudget("");
    setExpiryPreset("1w");
    setExpiry(toDatetimeLocal(Math.floor(Date.now() / 1000) + 7 * DAY));
  }

  async function submit() {
    if (!ready || expirySeconds === null || specState.kind !== "ok" || providerInput.kind !== "valid") return;
    setStage("create");
    const result = await run("Create job", () =>
      square.createJob({ provider: providerInput.address, expiredAt: BigInt(expirySeconds), spec: specState.value }),
    );
    if (!result) {
      setStage(null);
      return;
    }
    let budgetHash: Hex | undefined;
    let budgetFailed = false;
    if (budgetAmount !== null && budgetAmount > 0n) {
      setStage("budget");
      const set = await run("Set budget", () => square.setBudget(result.jobId, budgetAmount));
      if (set) budgetHash = set.hash;
      else budgetFailed = true;
    }
    setStage(null);
    setCreated({ jobId: result.jobId, createHash: result.hash, budgetHash, budgetFailed, budget: budgetAmount, spec, specHash: specState.hash });
  }

  const ctaLabel =
    stage === "create"
      ? "Confirm createJob in the wallet"
      : stage === "budget"
        ? "Confirm setBudget in the wallet"
        : budgetAmount !== null && budgetAmount > 0n
          ? "Create job and set budget"
          : "Create job";

  if (created) {
    const href = `/job?id=${created.jobId.toString()}`;
    return (
      <div className="flex flex-col gap-16">
        <SectionHeading title="New job" description="Opens a job on SquareJob with the keeper evaluator and the Square hook bound at creation." />
        <PanelCard elevated title={`Job #${created.jobId.toString()} is on chain`} description="Both receipts link to the explorer. The job is open until it is funded.">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
            <dl className="flex flex-col">
              <Row label="createJob">
                <TxLink hash={created.createHash} />
              </Row>
              <Row label="setBudget" muted={!created.budgetHash && !created.budgetFailed}>
                {created.budgetHash ? (
                  <TxLink hash={created.budgetHash} />
                ) : created.budgetFailed ? (
                  <span className="text-magenta">Not sent; set it from the job page</span>
                ) : (
                  "Skipped"
                )}
              </Row>
              <Row label="Provider">
                <AddressLink address={providerInput.kind === "valid" ? providerInput.address : provider} />
              </Row>
              <Row label="Budget" muted={created.budgetHash === undefined && !created.budgetFailed}>
                {created.budgetHash !== undefined && created.budget !== null ? (
                  <AmountUsdc value={created.budget} />
                ) : created.budgetFailed && created.budget !== null ? (
                  <span className="text-magenta">{formatUsdc(created.budget)} USDC requested, not set</span>
                ) : (
                  "Not set"
                )}
              </Row>
            </dl>
            <div className="flex flex-col gap-4">
              <p className="text-caption font-medium text-carbon">What happens next</p>
              <ol className="flex flex-col gap-3">
                {[
                  created.budgetHash !== undefined
                    ? { title: "Fund the escrow", body: "Approve USDC and fund from the job page. The fee basis points are snapshotted at that moment." }
                    : { title: "Set the budget, then fund the escrow", body: "Set a budget on the job page first, then approve USDC and fund it. Funding a job with no budget reverts with ZeroBudget." },
                  { title: "Hand the job to the provider", body: "Share the job link and the spec text below. The provider submits the deliverable hash before the expiry, optionally bound to an ERC-8004 agent." },
                  { title: "Watch the challenge window", body: `After submission you have ${network.data ? formatDuration(network.data.window.challengeWindow) : "the challenge window"} to dispute; otherwise anyone finalizes and the payee is credited.` },
                ].map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-mist text-caption tabular-nums text-graphite">
                      {index + 1}
                    </span>
                    <span>
                      <span className="block text-body font-medium text-carbon">{step.title}</span>
                      <span className="block text-caption text-graphite">{step.body}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex flex-wrap gap-3">
                <PrimaryButton href={href}>Open job #{created.jobId.toString()}</PrimaryButton>
                <GhostButton onClick={reset}>Create another</GhostButton>
              </div>
            </div>
          </div>
          <div className="mt-8 flex flex-col gap-3 border-t border-fog pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-caption font-medium text-carbon">The spec this job was hashed from</p>
                <p className="mt-1 max-w-xl text-caption text-graphite">
                  Only spec:{shortHash(created.specHash)} is on chain. Keep this text and send it to the provider over
                  your own channel; the job page checks a pasted spec against the hash. Create another clears it.
                </p>
              </div>
              <span className="flex items-center gap-2">
                <SpecActions spec={created.spec} hash={created.specHash} />
              </span>
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border border-fog bg-linen px-3.5 py-2.5 font-mono text-[12px] leading-5 text-graphite">
              {created.spec}
            </pre>
          </div>
        </PanelCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <SectionHeading
        title="New job"
        description="Four decisions, one transaction. The keeper evaluator and the Square hook are bound at creation; funding comes after."
      />

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr] lg:gap-12">
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Step
            number={1}
            title="Who does the work"
            description="The provider's wallet. It is fixed at creation and receives the net payout unless the receivable is sold."
            state={providerState}
            aside={providerInput.kind === "valid" ? <AddressLink address={providerInput.address} /> : null}
          >
            <Field label="Provider address" htmlFor="provider" error={providerError} hint={providerValid ? "Checksummed and ready." : "An agent's wallet on this chain."}>
              <input
                id="provider"
                className={`${inputClass} font-mono text-[13px]`}
                value={provider}
                onChange={(event) => setProvider(event.target.value.trim())}
                placeholder="0x"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            {providerInput.kind === "checksum" ? (
              <div>
                <GhostButton size="sm" onClick={() => setProvider(providerInput.suggestion)}>
                  Use {shortAddress(providerInput.suggestion)}
                </GhostButton>
              </div>
            ) : null}
          </Step>

          <Step
            number={2}
            title="When it must be done"
            description="After the expiry the provider can no longer submit and the client can reclaim the escrow."
            state={expiryState}
            aside={expiryValid && expirySeconds !== null ? <span className="text-caption tabular-nums text-graphite">in {formatDuration(expirySeconds - now)}</span> : null}
          >
            <div className="flex flex-wrap gap-2" role="group" aria-label="Expiry presets">
              {EXPIRY_PRESETS.map((preset) => (
                <PillToggle key={preset.id} selected={expiryPreset === preset.id} onClick={() => chooseExpiry(preset.id, preset.seconds)}>
                  {preset.label}
                </PillToggle>
              ))}
            </div>
            <Field
              label="Expiry"
              htmlFor="expiry"
              error={expiryError}
              hint={
                floor !== null
                  ? `Earliest ${formatTimestamp(floor.at)}: the settlement horizon of ${formatDuration(floor.horizon)} plus ${formatDuration(floor.margin)} of margin, so the job is still submittable once it is funded and delivered.`
                  : network.isError
                    ? `The settlement horizon could not be read: ${describeError(network.error)}`
                    : "Reading the settlement horizon from KeeperEvaluator."
              }
            >
              <input
                id="expiry"
                type="datetime-local"
                className={inputClass}
                value={expiry}
                min={minExpiry !== null ? toDatetimeLocal(minExpiry) : undefined}
                onChange={(event) => {
                  setExpiryPreset(null);
                  setExpiry(event.target.value);
                }}
              />
            </Field>
          </Step>

          <Step
            number={3}
            title="What is being bought"
            description="A JSON spec. It is canonicalized and hashed locally; only spec: followed by the keccak256 hash is stored on chain."
            state={specStepState}
            aside={
              specState.kind === "ok" ? (
                <span className="inline-flex items-center gap-2 text-caption text-graphite">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
                  Valid JSON, {byteLength(spec)} bytes
                </span>
              ) : specState.kind === "error" ? (
                <span className="inline-flex items-center gap-2 text-caption text-magenta">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-magenta" />
                  Not valid JSON
                </span>
              ) : null
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-caption text-graphite">Start from</span>
              {SPEC_TEMPLATES.map((entry) => (
                <PillToggle key={entry.id} selected={template === entry.id} onClick={() => applyTemplate(entry.id)}>
                  {entry.label}
                </PillToggle>
              ))}
              <span className="ml-auto flex items-center gap-2">
                <SpecActions spec={spec} hash={specState.kind === "ok" ? specState.hash : ""} />
                <GhostButton size="sm" onClick={formatSpec} disabled={specState.kind !== "ok"}>
                  Format
                </GhostButton>
                <GhostButton
                  size="sm"
                  onClick={() => {
                    setSpec("");
                    setTemplate(null);
                  }}
                  disabled={spec.length === 0}
                >
                  Clear
                </GhostButton>
              </span>
            </div>
            <Field
              label="Spec (JSON)"
              htmlFor="spec"
              error={specState.kind === "error" ? specState.message : null}
              hint={
                specState.kind === "ok" ? (
                  <span className="break-all font-mono text-[12px]">spec:{specState.hash}</span>
                ) : (
                  "Say what is delivered, how it is accepted and by when. Edit every template; the words never leave this page."
                )
              }
            >
              <JsonEditor
                id="spec"
                value={spec}
                error={specState.kind === "error" ? specState.message : null}
                onChange={(next) => {
                  setTemplate(null);
                  setSpec(next);
                }}
                placeholder={'{\n  "task": "...",\n  "deliverable": "...",\n  "acceptance": "..."\n}'}
              />
            </Field>
            {specState.kind === "ok" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-graphite">
                  <span className="tabular-nums">{spec.split("\n").length} lines</span>
                  <span className="tabular-nums">{byteLength(spec)} bytes typed</span>
                  <span className="tabular-nums">{byteLength(canonical)} bytes hashed</span>
                  <button
                    type="button"
                    onClick={() => setShowCanonical((current) => !current)}
                    className="text-carbon underline decoration-fog underline-offset-4 hover:decoration-carbon"
                    aria-expanded={showCanonical}
                  >
                    {showCanonical ? "Hide the canonical form" : "Show the canonical form"}
                  </button>
                </div>
                {showCanonical ? (
                  <pre className="overflow-x-auto rounded-lg border border-fog bg-linen px-3.5 py-2.5 font-mono text-[12px] leading-5 text-graphite">{canonical}</pre>
                ) : null}
                <p className="text-caption text-ash">Keys are sorted and whitespace dropped before hashing, so two specs that say the same thing hash the same.</p>
              </div>
            ) : null}
          </Step>

          <Step
            number={4}
            title="What it pays"
            description="Optional now. A budget is a second signature right after creation; the USDC itself moves when the job is funded."
            state={budgetState}
            last
            aside={net !== null ? <span className="text-caption tabular-nums text-graphite">{formatUsdc(net)} USDC net to the provider</span> : null}
          >
            <div className="flex flex-wrap gap-2" role="group" aria-label="Budget presets">
              {BUDGET_PRESETS.map((preset) => (
                <PillToggle key={preset} selected={budget === preset} onClick={() => setBudget(preset)}>
                  {preset} USDC
                </PillToggle>
              ))}
              <PillToggle selected={budget.length === 0} onClick={() => setBudget("")}>
                Later
              </PillToggle>
            </div>
            <Field label="Budget (USDC)" htmlFor="budget-amount" error={budgetError} hint="Up to six decimals. The provider agrees to it before funding.">
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center">
                  <UsdcMark className="size-4" />
                </span>
                <input id="budget-amount" inputMode="decimal" className={`${inputClass} pl-10`} value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="0.00" />
              </div>
            </Field>
          </Step>
        </form>

        <aside className="lg:sticky lg:top-28 lg:self-start">
          <PanelCard elevated title="Preview" description="What createJob writes, and what the budget would split into.">
            <dl className="flex flex-col">
              <Row label="Client" muted={address === undefined}>
                {address ? <AddressLink address={address} /> : "No wallet connected"}
              </Row>
              <Row label="Provider" muted={!providerValid}>
                {providerInput.kind === "valid" ? <AddressLink address={providerInput.address} /> : "Not set"}
              </Row>
              <Row label="Expires" muted={!expiryValid}>
                {expiryValid && expirySeconds !== null ? formatTimestamp(expirySeconds) : "Not set"}
              </Row>
              <Row label="Spec" muted={specState.kind !== "ok"}>
                {specState.kind === "ok" ? <span title={specState.description}>spec:{shortHash(specState.hash)}</span> : "Not set"}
              </Row>
              <Row label="Budget" muted={budgetAmount === null || budgetAmount === 0n}>
                {budgetAmount !== null && budgetAmount > 0n ? <AmountUsdc value={budgetAmount} /> : "Set later"}
              </Row>
              {fees && net !== null && network.data ? (
                <>
                  <Row label={`Platform fee ${formatBps(network.data.platformFeeBP)}`}>
                    <AmountUsdc value={fees.platform} />
                  </Row>
                  <Row label={`Evaluator fee ${formatBps(network.data.evaluatorFeeBP)}`}>
                    <AmountUsdc value={fees.evaluator} />
                  </Row>
                  <Row label="Net to the provider">
                    <AmountUsdc value={net} className="font-medium" />
                  </Row>
                </>
              ) : null}
            </dl>

            <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-fog bg-linen p-5">
              <p className="text-caption font-medium text-carbon">Bound at creation</p>
              <dl className="flex flex-col gap-2 text-caption">
                <div className="flex justify-between gap-4">
                  <dt className="text-graphite">Evaluator</dt>
                  <dd>
                    <AddressLink address={deployment.keeperEvaluator} label="KeeperEvaluator" />
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-graphite">Hook</dt>
                  <dd>
                    <AddressLink address={deployment.squareHook} label="SquareHook" />
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-graphite">Escrow token</dt>
                  <dd className="inline-flex items-center gap-1.5">
                    <UsdcMark className="size-3.5" />
                    <AddressLink address={deployment.usdc} label="USDC" />
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-graphite">Chain</dt>
                  <dd className="inline-flex items-center gap-1.5 tabular-nums text-carbon">
                    {isArcNetwork ? <ArcNetworkMark className="size-3.5" /> : null}
                    {activeChain.name} ({activeChain.id})
                  </dd>
                </div>
              </dl>
            </div>

            <ul className="mt-6 flex flex-col gap-2" aria-label="Ready to send">
              <Check done={providerValid}>Provider address</Check>
              <Check done={expiryValid}>Expiry with room left to submit</Check>
              <Check done={specState.kind === "ok"}>Valid JSON spec</Check>
              <Check done={onActiveChain}>Wallet connected on {activeChain.name}</Check>
            </ul>

            <div className="mt-6 flex flex-col gap-3">
              <PrimaryButton type="submit" disabled={!ready} onClick={() => void submit()} className="w-full">
                {ctaLabel}
              </PrimaryButton>
              {!onActiveChain ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-graphite">{address === undefined ? "Connect a wallet to send." : `Switch to ${activeChain.name} to send.`}</span>
                  <WalletButton />
                </div>
              ) : null}
              {txState.status === "error" ? (
                <p className="text-caption text-magenta" role="alert">
                  {txState.label}: {txState.message}
                </p>
              ) : null}
              <p className="text-caption text-ash">
                {budgetAmount !== null && budgetAmount > 0n ? "Two signatures: createJob, then setBudget." : "One signature: createJob."} Funding is a separate step on the job page.
              </p>
            </div>
          </PanelCard>
        </aside>
      </div>
    </div>
  );
}
