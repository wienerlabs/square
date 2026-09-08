"use client";

import { agentFromDid, hashDeliverable, JobStatus, Outcome, specHashFromDescription, type SquareClient, type TransactionResult } from "@squaresdk/core";
import { InvalidDidError } from "@squaresdk/did-resolver";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { isAddressEqual, type Address } from "viem";
import { useAccount } from "wagmi";
import { AddressLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { SegmentBar } from "@/components/charts/SegmentBar";
import { SettlementClock } from "@/components/charts/SettlementClock";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { Field, inputClass } from "@/components/Field";
import { GhostButton } from "@/components/GhostButton";
import { PanelCard } from "@/components/PanelCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { StatusPill, listingTone, outcomeTone, phaseTone } from "@/components/StatusPill";
import { chartColors, formatCompactUsdc, payoutSplit, settlementClock } from "@/lib/charts";
import { formatBps, formatCountdown, formatDuration, formatTimestamp, formatUsdc, isZeroAddress, parseUsdc, shortHash, statusLabel } from "@/lib/format";
import {
  countVotes,
  jobPhase,
  LISTING_LABELS,
  OUTCOME_LABELS,
  PHASE_LABELS,
  useJob,
  useNetwork,
  useNow,
  usePositions,
  useSquare,
  type JobDetail,
} from "@/lib/square";
import { describeError, useTx } from "@/lib/tx";
import { activeChain, deployment } from "@/lib/wagmi";

interface ActionContext {
  square: SquareClient;
  id: bigint;
  busy: boolean;
  canSend: boolean;
  reason: string | null;
  run: <T extends TransactionResult>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
}

function ActionCard({
  title,
  description,
  children,
  buttonLabel,
  onClick,
  disabled = false,
  ctx,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
  buttonLabel: string;
  onClick: () => void;
  disabled?: boolean;
  ctx: ActionContext;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-fog bg-paper-white p-6">
      <div>
        <h3 className="text-body font-medium text-carbon">{title}</h3>
        <p className="mt-1 text-caption text-graphite">{description}</p>
      </div>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton size="sm" onClick={onClick} disabled={disabled || ctx.busy || !ctx.canSend}>
          {buttonLabel}
        </PrimaryButton>
        {ctx.reason ? <span className="text-caption text-ash">{ctx.reason}</span> : null}
      </div>
    </div>
  );
}

function SimpleAction({
  title,
  description,
  buttonLabel,
  label,
  send,
  ctx,
}: {
  title: string;
  description: ReactNode;
  buttonLabel: string;
  label: string;
  send: (square: SquareClient) => Promise<TransactionResult>;
  ctx: ActionContext;
}) {
  return (
    <ActionCard
      title={title}
      description={description}
      buttonLabel={buttonLabel}
      onClick={() => void ctx.run(label, () => send(ctx.square))}
      ctx={ctx}
    />
  );
}

function SetBudgetAction({ ctx, detail }: { ctx: ActionContext; detail: JobDetail }) {
  const [value, setValue] = useState("");
  const amount = parseUsdc(value);
  return (
    <ActionCard
      title="Set budget"
      description="Agree the price while the job is open. The amount is escrowed at funding and capped at 2^64 base units."
      buttonLabel="Set budget"
      disabled={amount === null || amount === 0n}
      onClick={() => {
        if (amount !== null) void ctx.run("Set budget", () => ctx.square.setBudget(ctx.id, amount));
      }}
      ctx={ctx}
    >
      <Field
        label="Budget (USDC)"
        htmlFor="budget"
        hint={detail.record.budget > 0n ? <>Current budget {formatUsdc(detail.record.budget)} USDC</> : "No budget set yet"}
        error={value.length > 0 && amount === null ? "Enter an amount with up to six decimals." : null}
      >
        <input id="budget" inputMode="decimal" className={inputClass} value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.00" />
      </Field>
    </ActionCard>
  );
}

function parseAgent(input: string): { agentId?: bigint; error?: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  if (trimmed.startsWith("did:")) {
    try {
      return { agentId: agentFromDid(trimmed).agentId };
    } catch (error) {
      return { error: error instanceof InvalidDidError ? error.message : describeError(error) };
    }
  }
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a numeric ERC-8004 agent id or a did:aip identifier." };
  return { agentId: BigInt(trimmed) };
}

function SubmitAction({ ctx, detail, horizon, now }: { ctx: ActionContext; detail: JobDetail; horizon: number | undefined; now: number }) {
  const [content, setContent] = useState("");
  const [agent, setAgent] = useState("");
  const deliverable = useMemo(() => (content.length > 0 ? hashDeliverable(content) : null), [content]);
  const parsedAgent = useMemo(() => parseAgent(agent), [agent]);
  const tooClose = horizon !== undefined && detail.record.expiredAt < now + horizon;
  return (
    <ActionCard
      title="Submit"
      description="Posts the keccak256 hash of the deliverable. Binding an ERC-8004 agent lets the hook write reputation for it at settlement."
      buttonLabel="Submit deliverable"
      disabled={deliverable === null || parsedAgent.error !== undefined || tooClose}
      onClick={() => {
        if (deliverable === null) return;
        const agentId = parsedAgent.agentId;
        void ctx.run("Submit", () => ctx.square.submit({ jobId: ctx.id, deliverable, agentId }));
      }}
      ctx={ctx}
    >
      <Field
        label="Deliverable content"
        htmlFor="deliverable"
        hint={deliverable ? <span className="break-all tabular-nums">Hash {deliverable}</span> : "The text is hashed locally; only the hash goes on chain."}
      >
        <textarea id="deliverable" rows={5} className={inputClass} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Paste the deliverable text" />
      </Field>
      <Field label="Agent (optional)" htmlFor="agent" hint="ERC-8004 agent id, or a did:aip v2 identifier." error={parsedAgent.error ?? null}>
        <input id="agent" className={inputClass} value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="Agent id or did:aip identifier" />
      </Field>
      {tooClose && horizon !== undefined ? (
        <p className="text-caption text-magenta" role="alert">
          The expiry is closer than the settlement horizon of {formatDuration(horizon)}; submit would revert with ExpiryTooShort.
        </p>
      ) : null}
    </ActionCard>
  );
}

function VoteAction({ ctx, detail }: { ctx: ActionContext; detail: JobDetail }) {
  const [outcome, setOutcome] = useState<"complete" | "reject">("complete");
  const [bps, setBps] = useState("10000");
  const parsedBps = /^\d+$/.test(bps) ? Number(bps) : Number.NaN;
  const bpsValid = Number.isInteger(parsedBps) && parsedBps >= 1 && parsedBps <= 10_000;
  const votes = countVotes(detail.dispute.voted);
  return (
    <ActionCard
      title="Vote"
      description={`${votes} of ${detail.threshold} required votes cast by the ${detail.arbiters.length} arbiters of set v${detail.dispute.setVersion}. The first resolution to reach the threshold decides.`}
      buttonLabel="Cast vote"
      disabled={outcome === "complete" && !bpsValid}
      onClick={() => {
        if (outcome === "complete") {
          if (bpsValid) void ctx.run("Vote", () => ctx.square.vote(ctx.id, Outcome.Complete, parsedBps));
        } else {
          void ctx.run("Vote", () => ctx.square.vote(ctx.id, Outcome.Reject, 0));
        }
      }}
      ctx={ctx}
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="text-caption font-medium text-carbon">Resolution</legend>
        <label className="flex items-center gap-3 text-body">
          <input type="radio" name="outcome" className="accent-lavender" checked={outcome === "complete"} onChange={() => setOutcome("complete")} />
          Complete, the provider receives a share of the net payout
        </label>
        {outcome === "complete" ? (
          <Field label="Provider share in basis points (1 to 10000)" htmlFor="bps" error={bpsValid ? null : "Enter an integer between 1 and 10000."}>
            <input id="bps" inputMode="numeric" className={inputClass} value={bps} onChange={(event) => setBps(event.target.value)} />
          </Field>
        ) : null}
        <label className="flex items-center gap-3 text-body">
          <input type="radio" name="outcome" className="accent-lavender" checked={outcome === "reject"} onChange={() => setOutcome("reject")} />
          Reject, the client is refunded in full
        </label>
      </fieldset>
    </ActionCard>
  );
}

function ListClaimAction({ ctx, detail }: { ctx: ActionContext; detail: JobDetail }) {
  const [value, setValue] = useState("");
  const price = parseUsdc(value);
  const face = detail.netPayout;
  const valid = price !== null && price > 0n && price < face;
  return (
    <ActionCard
      title="List the receivable"
      description="Sells the right to this job's net payout. The buyer becomes the payee at finalize; reputation stays with the agent."
      buttonLabel="List claim"
      disabled={!valid}
      onClick={() => {
        if (price !== null && valid) void ctx.run("List claim", () => ctx.square.listClaim(ctx.id, price));
      }}
      ctx={ctx}
    >
      <Field
        label="Price (USDC)"
        htmlFor="price"
        hint={<>Face value {formatUsdc(face)} USDC; the price must be below it.</>}
        error={value.length > 0 && !valid ? "Enter a price above zero and below the face value." : null}
      >
        <input id="price" inputMode="decimal" className={inputClass} value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.00" />
      </Field>
    </ActionCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-graphite">{label}</dt>
      <dd className="mt-1 break-words text-body text-carbon">{children}</dd>
    </div>
  );
}

function Timeline({ detail, now }: { detail: JobDetail; now: number }) {
  const record = detail.record;
  const terminal = record.status >= JobStatus.Completed;
  const items: { label: string; at?: number; state: "done" | "pending" | "future"; note?: string }[] = [];
  items.push({ label: "Created", at: record.createdAt, state: "done" });
  items.push({ label: "Funded", at: record.fundedAt > 0 ? record.fundedAt : undefined, state: record.fundedAt > 0 ? "done" : "future" });
  items.push({ label: "Submitted", at: record.submittedAt > 0 ? record.submittedAt : undefined, state: record.submittedAt > 0 ? "done" : "future" });
  if (record.submittedAt > 0 && detail.challengeEnd > 0) {
    items.push({ label: "Challenge window ends", at: detail.challengeEnd, state: now >= detail.challengeEnd ? "done" : "pending" });
  }
  if (detail.dispute.disputedAt !== 0) {
    items.push({ label: "Disputed", at: detail.dispute.disputedAt, state: "done", note: `Bond ${formatUsdc(detail.dispute.bond)} USDC` });
    items.push({
      label: "Resolve by",
      at: detail.dispute.resolveBy,
      state: detail.dispute.outcome !== 0 || now >= detail.dispute.resolveBy ? "done" : "pending",
      note: OUTCOME_LABELS[detail.dispute.outcome] ?? `Outcome ${detail.dispute.outcome}`,
    });
  }
  if (terminal) {
    items.push({ label: statusLabel(record.status), state: "done", note: "The kernel stores no settlement timestamp; the explorer has the block." });
  } else {
    items.push({ label: "Expires", at: record.expiredAt, state: now >= record.expiredAt ? "done" : "future" });
  }
  return (
    <ol className="flex flex-col">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`} className="relative flex gap-4 pb-6 last:pb-0">
          {index < items.length - 1 ? <span aria-hidden="true" className="absolute left-[5px] top-4 h-full w-px bg-fog" /> : null}
          <span
            aria-hidden="true"
            className={`mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-paper-white ${item.state === "done" ? "bg-carbon" : item.state === "pending" ? "bg-amber" : "bg-fog"}`}
          />
          <div className="flex flex-col">
            <span className={`text-body font-medium ${item.state === "future" ? "text-ash" : "text-carbon"}`}>{item.label}</span>
            <span className="text-caption tabular-nums text-graphite">
              {item.at !== undefined ? formatTimestamp(item.at) : item.state === "future" ? "Not yet" : ""}
              {item.at !== undefined && item.state === "pending" ? ` (${formatCountdown(item.at, now)})` : ""}
            </span>
            {item.note ? <span className="text-caption text-ash">{item.note}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function sameAddress(a: Address | undefined, b: Address | undefined): boolean {
  return a !== undefined && b !== undefined && isAddressEqual(a, b);
}

export function JobView() {
  const params = useSearchParams();
  const raw = params.get("id");
  const id = raw !== null && /^\d+$/.test(raw) ? BigInt(raw) : null;
  const job = useJob(id);
  const network = useNetwork();
  const { address, chainId } = useAccount();
  const positions = usePositions(address);
  const now = useNow();
  const square = useSquare();
  const { run, busy } = useTx();

  if (id === null) {
    return (
      <EmptyState
        title="Pick a job"
        hint="Open a job from the dashboard, or add ?id= followed by the job number to this address."
        action={<GhostButton href="/dashboard">Go to the dashboard</GhostButton>}
      />
    );
  }
  if (job.isPending) return <EmptyState title={`Reading job #${id.toString()} from the chain`} />;
  if (job.isError) return <EmptyState title="The chain read failed" hint={describeError(job.error)} />;
  if (!job.data) {
    return (
      <EmptyState
        title={`No job with id ${id.toString()}`}
        hint="Job ids start at 1 and run up to the current jobCounter."
        action={<GhostButton href="/dashboard">Go to the dashboard</GhostButton>}
      />
    );
  }

  const detail = job.data;
  const record = detail.record;
  const phase = jobPhase({ status: record.status, challengeEnd: detail.challengeEnd, disputed: detail.disputed }, now);
  const specHash = specHashFromDescription(record.description);
  const isClient = sameAddress(address, record.client);
  const isProvider = sameAddress(address, record.provider);
  const keeperEvaluates = isAddressEqual(record.evaluator, deployment.keeperEvaluator);
  const hookIsSquare = isAddressEqual(record.hook, deployment.squareHook);
  const windowClosed = detail.challengeEnd > 0 && now >= detail.challengeEnd;
  const neverDisputed = detail.keeperDispute.disputedAt === 0;
  const disputeOpen = detail.dispute.disputedAt !== 0 && detail.dispute.outcome === 0;
  const isArbiter = address !== undefined && detail.arbiters.some((arbiter) => isAddressEqual(arbiter, address));
  const listing = detail.listing;
  const canSend = address !== undefined && chainId === activeChain.id;
  const reason = address === undefined ? "Connect a wallet to send this transaction." : chainId !== activeChain.id ? `Switch the wallet to ${activeChain.name}.` : null;
  const ctx: ActionContext = { square, id, busy, canSend, reason, run };

  const showSetBudget = record.status === JobStatus.Open && (isClient || isProvider);
  const showFund = record.status === JobStatus.Open && isClient && record.budget > 0n && !isZeroAddress(record.provider) && now < record.expiredAt;
  const showSubmit = record.status === JobStatus.Funded && isProvider && now < record.expiredAt;
  const showFinalize = record.status === JobStatus.Submitted && keeperEvaluates && neverDisputed && windowClosed;
  const showDispute = record.status === JobStatus.Submitted && keeperEvaluates && isClient && neverDisputed && !windowClosed;
  const showVote = disputeOpen && isArbiter;
  const showLapse = disputeOpen && now >= detail.dispute.resolveBy;
  const showFinalizeDecided =
    record.status === JobStatus.Submitted &&
    detail.keeperDispute.disputedAt !== 0 &&
    !detail.keeperDispute.resolved &&
    (detail.dispute.outcome === Outcome.Complete || detail.dispute.outcome === Outcome.Lapsed);
  const payoutRouted = record.hookResolvesPayout && hookIsSquare;
  const showList = record.status === JobStatus.Submitted && isProvider && payoutRouted && listing.status !== 1 && listing.status !== 2 && detail.netPayout > 0n;
  const showBuy = listing.status === 1 && payoutRouted && address !== undefined && !sameAddress(address, listing.seller) && !isProvider && !isClient;
  const showCancel = listing.status === 1 && sameAddress(address, listing.seller);
  const showReject = record.status === JobStatus.Open && isClient;
  const expired = now >= record.expiredAt;
  const showClaimRefund = expired && (record.status === JobStatus.Funded || (record.status === JobStatus.Submitted && !keeperEvaluates));
  const expiryHeldByKeeper = expired && record.status === JobStatus.Submitted && keeperEvaluates;
  const withdrawable = positions.data?.withdrawable ?? 0n;
  const bondWithdrawable = positions.data?.bondWithdrawable ?? 0n;
  const showRecordExpiry = record.status === JobStatus.Expired && detail.agentId !== 0n && !detail.expiryRecorded;
  const anyAction =
    showSetBudget ||
    showFund ||
    showSubmit ||
    showFinalize ||
    showDispute ||
    showVote ||
    showLapse ||
    showFinalizeDecided ||
    showList ||
    showBuy ||
    showCancel ||
    showReject ||
    showClaimRefund ||
    withdrawable > 0n ||
    bondWithdrawable > 0n ||
    showRecordExpiry;

  const feeSnapshot = record.fundedAt > 0 ? `${formatBps(record.platformFeeBP)} platform, ${formatBps(record.evaluatorFeeBP)} evaluator` : "Taken at funding";
  const clock = settlementClock({
    createdAt: record.createdAt,
    fundedAt: record.fundedAt,
    submittedAt: record.submittedAt,
    expiredAt: record.expiredAt,
    challengeEnd: detail.challengeEnd,
    disputedAt: detail.dispute.disputedAt,
    resolveBy: detail.dispute.resolveBy,
    status: record.status,
    now,
  });
  const split = record.fundedAt > 0 ? payoutSplit(record, detail.netPayout) : null;

  return (
    <div className="flex flex-col gap-16">
      <section className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-heading font-medium tabular-nums text-carbon">Job #{id.toString()}</h1>
          <StatusPill label={PHASE_LABELS[phase]} tone={phaseTone[phase]} />
          {detail.dispute.disputedAt !== 0 ? <StatusPill label={`Dispute ${OUTCOME_LABELS[detail.dispute.outcome] ?? detail.dispute.outcome}`} tone={outcomeTone[detail.dispute.outcome] ?? "neutral"} /> : null}
          {listing.status !== 0 ? <StatusPill label={`Claim ${LISTING_LABELS[listing.status] ?? listing.status}`} tone={listingTone[listing.status] ?? "neutral"} /> : null}
          <div className="ml-auto flex items-center gap-2">
            <GhostButton size="sm" href="/dashboard">
              Back to jobs
            </GhostButton>
          </div>
        </div>
        <p className="text-caption text-graphite">
          Status {statusLabel(record.status)} on SquareJob; read again every ten seconds.
          {record.status === JobStatus.Submitted && detail.challengeEnd > 0 && !detail.disputed ? ` Challenge window ${formatCountdown(detail.challengeEnd, now).toLowerCase()}.` : ""}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <PanelCard title="Record" description="Every field below is the on-chain job record.">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Row label="Client">
              <AddressLink address={record.client} />
            </Row>
            <Row label="Provider">
              <AddressLink address={record.provider} />
            </Row>
            <Row label="Evaluator">
              <span className="flex flex-wrap items-center gap-2">
                <AddressLink address={record.evaluator} />
                {keeperEvaluates ? <Chip>KeeperEvaluator</Chip> : null}
              </span>
            </Row>
            <Row label="Hook">
              <span className="flex flex-wrap items-center gap-2">
                <AddressLink address={record.hook} />
                {hookIsSquare ? <Chip>SquareHook</Chip> : null}
              </span>
            </Row>
            <Row label="Budget">
              <AmountUsdc value={record.budget} />
            </Row>
            <Row label="Net payout">{record.fundedAt > 0 ? <AmountUsdc value={detail.netPayout} /> : <span className="text-ash">Fixed at funding</span>}</Row>
            <Row label="Fee snapshot">{feeSnapshot}</Row>
            <Row label="Payee of record">
              <span className="flex flex-wrap items-center gap-2">
                <AddressLink address={detail.payee} />
                {listing.status === 2 ? <Chip dot="mint">Receivable buyer</Chip> : null}
              </span>
            </Row>
            {record.status === JobStatus.Completed ? (
              <Row label="Settled to">
                <span className="flex flex-wrap items-center gap-2">
                  <AddressLink address={record.payee} />
                  <span className="text-caption text-graphite">{formatBps(record.providerBps)} of net</span>
                </span>
              </Row>
            ) : null}
            <Row label="Deliverable">
              {record.submittedAt > 0 ? (
                <span className="tabular-nums" title={record.deliverable}>
                  {shortHash(record.deliverable)}
                </span>
              ) : (
                <span className="text-ash">Not submitted</span>
              )}
            </Row>
            <Row label={specHash ? "Spec hash" : "Description"}>
              {record.description.length === 0 ? (
                <span className="text-ash">Empty</span>
              ) : (
                <span className="break-all tabular-nums" title={record.description}>
                  {specHash ? `spec:${shortHash(specHash)}` : record.description}
                </span>
              )}
            </Row>
            <Row label="Agent">{detail.agentId !== 0n ? <span className="tabular-nums">ERC-8004 agent #{detail.agentId.toString()}</span> : <span className="text-ash">Not bound</span>}</Row>
            <Row label="Created">{formatTimestamp(record.createdAt)}</Row>
            <Row label="Expires">
              {formatTimestamp(record.expiredAt)}
              {now < record.expiredAt ? <span className="text-caption text-graphite"> ({formatDuration(record.expiredAt - now)} left)</span> : null}
            </Row>
          </dl>
        </PanelCard>
        <PanelCard title="Timeline" description="Built from the record's timestamps and the keeper window.">
          <Timeline detail={detail} now={now} />
        </PanelCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <PanelCard title="Settlement clock" description="The job's phases laid out in time: how long each took, which one is running, and where now sits.">
          <SettlementClock clock={clock} />
        </PanelCard>
        <PanelCard title="Payout split" description={split ? "How the escrowed budget divides at settlement, from the fee basis points snapshotted at funding." : "Fees are snapshotted when the job is funded."}>
          {split ? (
            <SegmentBar
              ariaLabel="Payout split of the budget"
              total={split.budget}
              segments={[
                { key: "provider", label: split.providerBps < 10_000 ? "Provider share" : "Net payout", value: split.providerShare, color: chartColors.lavender, display: `${formatCompactUsdc(split.providerShare)} USDC` },
                ...(split.clientShare > 0 ? [{ key: "client", label: "Returned to client", value: split.clientShare, color: chartColors.sky, display: `${formatCompactUsdc(split.clientShare)} USDC` }] : []),
                { key: "platform", label: `Platform fee ${formatBps(record.platformFeeBP)}`, value: split.platformFee, color: chartColors.carbon, display: `${formatCompactUsdc(split.platformFee)} USDC` },
                { key: "evaluator", label: `Evaluator fee ${formatBps(record.evaluatorFeeBP)}`, value: split.evaluatorFee, color: chartColors.amber, display: `${formatCompactUsdc(split.evaluatorFee)} USDC` },
              ]}
            />
          ) : (
            <p className="text-caption text-ash">No budget has been escrowed for this job yet.</p>
          )}
          {split && split.providerBps < 10_000 ? (
            <p className="mt-4 text-caption text-graphite">The dispute decision awarded {formatBps(split.providerBps)} of the net payout to the provider; the rest goes back to the client.</p>
          ) : null}
        </PanelCard>
      </div>

      {listing.status !== 0 || detail.dispute.disputedAt !== 0 ? (
        <div className={`grid gap-4 ${listing.status !== 0 && detail.dispute.disputedAt !== 0 ? "lg:grid-cols-2" : ""}`}>
          {listing.status !== 0 ? (
            <PanelCard title="Receivable listing" description="From ClaimMarket.getListing.">
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                <Row label="Status">
                  <StatusPill label={LISTING_LABELS[listing.status] ?? `Status ${listing.status}`} tone={listingTone[listing.status] ?? "neutral"} />
                </Row>
                <Row label="Seller">
                  <AddressLink address={listing.seller} />
                </Row>
                <Row label="Buyer">
                  <AddressLink address={listing.buyer} />
                </Row>
                <Row label="Price">
                  <AmountUsdc value={listing.price} />
                </Row>
                <Row label="Face value">
                  <AmountUsdc value={listing.faceValue} />
                </Row>
                <Row label="Discount">
                  {listing.faceValue > 0n ? formatBps(Number(((listing.faceValue - listing.price) * 10_000n) / listing.faceValue)) : "n/a"}
                </Row>
              </dl>
            </PanelCard>
          ) : null}
          {detail.dispute.disputedAt !== 0 ? (
            <PanelCard title="Dispute" description="From Arbitration.disputeOf and the keeper's dispute reference.">
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                <Row label="Outcome">
                  <StatusPill label={OUTCOME_LABELS[detail.dispute.outcome] ?? `Outcome ${detail.dispute.outcome}`} tone={outcomeTone[detail.dispute.outcome] ?? "neutral"} />
                </Row>
                <Row label="Disputer">
                  <AddressLink address={detail.dispute.disputer} />
                </Row>
                <Row label="Bond">
                  <AmountUsdc value={detail.dispute.bond} />
                </Row>
                <Row label="Opened">{formatTimestamp(detail.dispute.disputedAt)}</Row>
                <Row label="Resolve by">
                  {formatTimestamp(detail.dispute.resolveBy)}
                  {detail.dispute.outcome === 0 ? <span className="text-caption text-graphite"> ({formatCountdown(detail.dispute.resolveBy, now).toLowerCase()})</span> : null}
                </Row>
                <Row label="Votes">
                  <span className="tabular-nums">
                    {countVotes(detail.dispute.voted)} cast, {detail.threshold} required
                  </span>
                </Row>
                <Row label={`Arbiter set v${detail.dispute.setVersion}`}>
                  <span className="flex flex-col gap-1">
                    {detail.arbiters.map((arbiter) => (
                      <AddressLink key={arbiter} address={arbiter} />
                    ))}
                  </span>
                </Row>
                {detail.dispute.outcome === Outcome.Complete || detail.dispute.outcome === Outcome.Lapsed ? (
                  <Row label="Provider share">{formatBps(detail.dispute.providerBps)}</Row>
                ) : null}
                <Row label="Applied on the kernel">{detail.keeperDispute.resolved ? "Yes" : "Not yet"}</Row>
                <Row label="Bond settled">{detail.dispute.bondSettled ? "Yes" : "Not yet"}</Row>
              </dl>
            </PanelCard>
          ) : null}
        </div>
      ) : null}

      <PanelCard
        title="Actions"
        description={
          address
            ? `Lifecycle actions available to ${address} right now. Each one sends a transaction through the SDK.`
            : "Connect a wallet to see the lifecycle actions it can take. Permissionless steps are listed regardless."
        }
      >
        {anyAction ? (
          <div className="grid gap-4 md:grid-cols-2">
            {showSetBudget ? <SetBudgetAction ctx={ctx} detail={detail} /> : null}
            {showFund ? (
              <SimpleAction
                ctx={ctx}
                title="Fund"
                label="Fund"
                buttonLabel={`Fund ${formatUsdc(record.budget)} USDC`}
                description="Moves the budget into escrow and snapshots the fee basis points. If the USDC allowance is short, an approval is sent first."
                send={(client) => client.fund(id, record.budget)}
              />
            ) : null}
            {showSubmit ? <SubmitAction ctx={ctx} detail={detail} horizon={network.data?.settlementHorizon} now={now} /> : null}
            {showFinalize ? (
              <SimpleAction
                ctx={ctx}
                title="Finalize"
                label="Finalize"
                buttonLabel="Finalize"
                description="The challenge window closed without a dispute. Anyone may finalize; the caller is paid the evaluator fee and the hook routes the payout."
                send={(client) => client.finalize(id)}
              />
            ) : null}
            {showDispute ? (
              <SimpleAction
                ctx={ctx}
                title="Dispute"
                label="Dispute"
                buttonLabel={`Dispute with a ${formatUsdc(detail.bond)} USDC bond`}
                description={`Opens an arbitration case. The bond from Arbitration.bondFor is ${formatUsdc(detail.bond)} USDC; an approval is sent first if the allowance is short. The window closes in ${formatDuration(detail.challengeEnd - now)}.`}
                send={(client) => client.dispute(id)}
              />
            ) : null}
            {showVote ? <VoteAction ctx={ctx} detail={detail} /> : null}
            {showFinalizeDecided ? (
              <SimpleAction
                ctx={ctx}
                title="Apply the decision"
                label="Finalize decided"
                buttonLabel="Finalize decided"
                description={`The arbiters reached ${OUTCOME_LABELS[detail.dispute.outcome] ?? "a decision"} with ${formatBps(detail.dispute.providerBps)} to the provider. Anyone may apply it on the kernel and settle the bond.`}
                send={(client) => client.finalizeDecided(id)}
              />
            ) : null}
            {showLapse ? (
              <SimpleAction
                ctx={ctx}
                title="Lapse the dispute"
                label="Lapse"
                buttonLabel="Lapse"
                description="The resolve-by time passed without a decision. Lapsing records the optimistic outcome so the job can be finalized."
                send={(client) => client.lapse(id)}
              />
            ) : null}
            {showList ? <ListClaimAction ctx={ctx} detail={detail} /> : null}
            {showBuy ? (
              <SimpleAction
                ctx={ctx}
                title="Buy the receivable"
                label="Buy claim"
                buttonLabel={`Buy for ${formatUsdc(listing.price)} USDC`}
                description={`Pays the seller ${formatUsdc(listing.price)} USDC for a face value of ${formatUsdc(listing.faceValue)} USDC. An approval is sent first if the allowance is short.`}
                send={(client) => client.buyClaim(id)}
              />
            ) : null}
            {showCancel ? (
              <SimpleAction
                ctx={ctx}
                title="Cancel the listing"
                label="Cancel claim"
                buttonLabel="Cancel listing"
                description="Withdraws the receivable from the market. A cancelled listing can be replaced later."
                send={(client) => client.cancelClaim(id)}
              />
            ) : null}
            {showReject ? (
              <SimpleAction
                ctx={ctx}
                title="Cancel the job"
                label="Reject"
                buttonLabel="Reject job"
                description="Rejects the open job before anything is escrowed. No refund is needed and no reputation signal is written."
                send={(client) => client.reject(id)}
              />
            ) : null}
            {showClaimRefund ? (
              <SimpleAction
                ctx={ctx}
                title="Claim refund"
                label="Claim refund"
                buttonLabel="Claim refund"
                description={
                  record.status === JobStatus.Submitted
                    ? "The expiry passed and the evaluator has no settlement horizon, so the submission does not hold the escrow. Anyone may trigger the refund; the client is credited on the ledger."
                    : "The expiry passed with the budget still in escrow and nothing submitted. Anyone may trigger the refund; the client is credited on the ledger."
                }
                send={(client) => client.claimRefund(id)}
              />
            ) : null}
            {expiryHeldByKeeper ? (
              <p className="text-caption text-graphite">
                The expiry passed after the submission. The keeper evaluator settles this job instead of a refund: finalize once the window closes, or a dispute the arbiters decide or that lapses.
              </p>
            ) : null}
            {withdrawable > 0n ? (
              <SimpleAction
                ctx={ctx}
                title="Withdraw"
                label="Withdraw"
                buttonLabel={`Withdraw ${formatUsdc(withdrawable)} USDC`}
                description="Pulls every credit on the SquareJob ledger for the connected wallet, across all jobs."
                send={(client) => client.withdraw()}
              />
            ) : null}
            {bondWithdrawable > 0n ? (
              <SimpleAction
                ctx={ctx}
                title="Withdraw bond"
                label="Withdraw bond"
                buttonLabel={`Withdraw ${formatUsdc(bondWithdrawable)} USDC`}
                description="Pulls the bond credits on the Arbitration ledger for the connected wallet."
                send={(client) => client.withdrawBond()}
              />
            ) : null}
            {showRecordExpiry ? (
              <SimpleAction
                ctx={ctx}
                title="Record the expiry"
                label="Record expiry"
                buttonLabel="Record expiry"
                description="Writes the neutral reputation signal for the bound agent on the hook. Permissionless and idempotent."
                send={(client) => client.recordExpiry(id)}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState
            title={address ? "Nothing to do from this wallet right now" : "No permissionless step is open right now"}
            hint={address ? "The job is waiting on another party or on the clock." : "Connect the client, provider or an arbiter wallet to see role-gated actions."}
          />
        )}
      </PanelCard>
    </div>
  );
}
