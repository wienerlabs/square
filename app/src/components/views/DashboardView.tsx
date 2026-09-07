"use client";

import { JobStatus } from "@squaresdk/core";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { AddressLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { EscrowFlowChart } from "@/components/charts/EscrowFlowChart";
import { PipelineChart } from "@/components/charts/PipelineChart";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { GhostButton } from "@/components/GhostButton";
import { MetricCard } from "@/components/MetricCard";
import { PanelCard } from "@/components/PanelCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SectionHeading } from "@/components/SectionHeading";
import { StatusPill, phaseTone } from "@/components/StatusPill";
import { TabBar } from "@/components/TabBar";
import { escrowFlow, phaseBreakdown } from "@/lib/charts";
import { formatBigint, formatCountdown, formatTimestamp } from "@/lib/format";
import { indexerUrl, useIndexerOverview } from "@/lib/indexer";
import { jobPhase, PHASE_LABELS, useJobs, useNow, usePositions, useSquare, type JobPhase, type JobSummary } from "@/lib/square";
import { describeError, useTx } from "@/lib/tx";
import { activeChain } from "@/lib/wagmi";

const tabs = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "in-window", label: "In window" },
  { id: "finalizable", label: "Finalizable" },
  { id: "completed", label: "Completed" },
  { id: "disputed", label: "Disputed" },
];

function matchesTab(job: JobSummary, phase: JobPhase, tab: string): boolean {
  switch (tab) {
    case "open":
      return job.status === JobStatus.Open || job.status === JobStatus.Funded;
    case "in-window":
      return phase === "in-window";
    case "finalizable":
      return phase === "finalizable";
    case "completed":
      return job.status === JobStatus.Completed;
    case "disputed":
      return job.disputed;
    default:
      return true;
  }
}

function ChallengeCell({ job, now }: { job: JobSummary; now: number }) {
  if (job.status === JobStatus.Submitted) {
    if (job.disputed) return <span className="text-graphite">Paused by dispute</span>;
    if (job.challengeEnd === 0) return <span className="text-ash">Unknown</span>;
    return (
      <span className="flex flex-col">
        <span className="tabular-nums text-carbon">{formatCountdown(job.challengeEnd, now)}</span>
        <span className="text-caption tabular-nums text-ash">{formatTimestamp(job.challengeEnd)}</span>
      </span>
    );
  }
  if (job.status === JobStatus.Open || job.status === JobStatus.Funded) {
    return <span className="text-ash">Not submitted</span>;
  }
  return <span className="text-ash">Settled</span>;
}

export function DashboardView() {
  const [tab, setTab] = useState("all");
  const now = useNow();
  const jobsQuery = useJobs();
  const indexer = useIndexerOverview();
  const { address, chainId } = useAccount();
  const positions = usePositions(address);
  const square = useSquare();
  const { run, busy } = useTx();

  const jobs = jobsQuery.data?.jobs ?? [];
  const scanned = jobsQuery.data?.scanned ?? 0;
  const withPhase = jobs.map((job) => ({ job, phase: jobPhase(job, now) }));
  const counts = {
    open: withPhase.filter(({ job }) => job.status === JobStatus.Open || job.status === JobStatus.Funded).length,
    inWindow: withPhase.filter(({ phase }) => phase === "in-window").length,
    finalizable: withPhase.filter(({ phase }) => phase === "finalizable").length,
    completed: withPhase.filter(({ job }) => job.status === JobStatus.Completed).length,
    disputed: withPhase.filter(({ job }) => job.disputed).length,
  };
  const tabCounts: Record<string, number> = {
    all: jobs.length,
    open: counts.open,
    "in-window": counts.inWindow,
    finalizable: counts.finalizable,
    completed: counts.completed,
    disputed: counts.disputed,
  };
  const filtered = withPhase.filter(({ job, phase }) => matchesTab(job, phase, tab));
  const flow = jobsQuery.data ? escrowFlow(jobs) : null;
  const slices = jobsQuery.data ? phaseBreakdown(jobs, now, PHASE_LABELS) : [];

  const indexerData = indexer.data;
  const caption = indexerUrl
    ? indexerData
      ? `Open and in window come from the indexer at ${indexerUrl} (last indexed block ${indexerData.status.lastIndexedBlock ?? "unknown"}). Completed is counted over the ${scanned} most recent job ids read from the chain.`
      : indexer.isError
        ? `The indexer at ${indexerUrl} did not answer (${describeError(indexer.error)}). Counts fall back to the ${scanned} most recent job ids read from the chain.`
        : `Waiting for the indexer at ${indexerUrl}. Counts below are read over the ${scanned} most recent job ids from the chain.`
    : `No indexer is configured. Open, in window and completed are counted over the ${scanned} most recent job ids (at most 50) read directly from the chain; the total comes from jobCounter.`;

  const onActiveChain = address !== undefined && chainId === activeChain.id;

  const columns: Column<{ job: JobSummary; phase: JobPhase }>[] = [
    {
      key: "id",
      header: "Id",
      render: ({ job }) => (
        <Link
          href={`/job?id=${job.id.toString()}`}
          className="font-medium tabular-nums text-carbon underline decoration-fog underline-offset-4 hover:decoration-carbon"
        >
          #{job.id.toString()}
        </Link>
      ),
    },
    { key: "client", header: "Client", render: ({ job }) => <AddressLink address={job.client} /> },
    { key: "provider", header: "Provider", render: ({ job }) => <AddressLink address={job.provider} /> },
    { key: "budget", header: "Budget", align: "right", render: ({ job }) => <AmountUsdc value={job.budget} /> },
    { key: "status", header: "Status", render: ({ phase }) => <StatusPill label={PHASE_LABELS[phase]} tone={phaseTone[phase]} /> },
    { key: "window", header: "Challenge end", render: ({ job }) => <ChallengeCell job={job} now={now} /> },
    {
      key: "detail",
      header: "",
      align: "right",
      render: ({ job }) => (
        <GhostButton size="sm" href={`/job?id=${job.id.toString()}`}>
          Detail
        </GhostButton>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-16">
      <section className="flex flex-col gap-8">
        <SectionHeading
          title="Dashboard"
          description={`Jobs on ${activeChain.name}, read from the chain every ten seconds.`}
          actions={<PrimaryButton href="/new">New job</PrimaryButton>}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Total jobs"
            loading={jobsQuery.isPending}
            value={jobsQuery.data ? formatBigint(jobsQuery.data.counter) : "Unavailable"}
            hint="jobCounter on SquareJob"
          />
          <MetricCard
            label="Open"
            loading={jobsQuery.isPending && !indexerData}
            value={indexerData ? indexerData.open.length : jobsQuery.data ? counts.open : "Unavailable"}
            hint="Open or funded, not yet submitted"
          />
          <MetricCard
            label="In window"
            loading={jobsQuery.isPending && !indexerData}
            value={indexerData ? indexerData.inWindow.length : jobsQuery.data ? counts.inWindow : "Unavailable"}
            hint="Submitted, undisputed, window still open"
          />
          <MetricCard
            label="Completed"
            loading={jobsQuery.isPending}
            value={jobsQuery.data ? counts.completed : "Unavailable"}
            hint="Status Completed on the kernel"
          />
        </div>
        <p className="text-caption text-graphite">{caption}</p>
      </section>

      <section aria-label="Activity" className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <EscrowFlowChart series={flow} scanned={scanned} loading={jobsQuery.isPending} />
        <PipelineChart slices={slices} scanned={scanned} loading={jobsQuery.isPending} />
      </section>

      {address ? (
        <PanelCard elevated title="Your positions" description="Pull-payment balances credited to the connected wallet.">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-fog p-6">
              <p className="text-caption text-graphite">USDC balance</p>
              <p className="mt-2 text-subheading font-medium">
                {positions.data ? <AmountUsdc value={positions.data.usdcBalance} /> : positions.isError ? "Unavailable" : "Loading"}
              </p>
            </div>
            <div className="flex flex-col gap-4 rounded-2xl border border-fog p-6">
              <div>
                <p className="text-caption text-graphite">Withdrawable from SquareJob</p>
                <p className="mt-2 text-subheading font-medium">
                  {positions.data ? <AmountUsdc value={positions.data.withdrawable} /> : positions.isError ? "Unavailable" : "Loading"}
                </p>
              </div>
              <div>
                <PrimaryButton
                  size="sm"
                  disabled={busy || !onActiveChain || !positions.data || positions.data.withdrawable === 0n}
                  onClick={() => void run("Withdraw", () => square.withdraw())}
                >
                  Withdraw
                </PrimaryButton>
              </div>
            </div>
            <div className="flex flex-col gap-4 rounded-2xl border border-fog p-6">
              <div>
                <p className="text-caption text-graphite">Withdrawable from Arbitration</p>
                <p className="mt-2 text-subheading font-medium">
                  {positions.data ? <AmountUsdc value={positions.data.bondWithdrawable} /> : positions.isError ? "Unavailable" : "Loading"}
                </p>
              </div>
              <div>
                <PrimaryButton
                  size="sm"
                  disabled={busy || !onActiveChain || !positions.data || positions.data.bondWithdrawable === 0n}
                  onClick={() => void run("Withdraw bond", () => square.withdrawBond())}
                >
                  Withdraw bond
                </PrimaryButton>
              </div>
            </div>
          </div>
          {!onActiveChain ? (
            <p className="mt-4 text-caption text-ash">Switch the wallet to {activeChain.name} to withdraw.</p>
          ) : null}
        </PanelCard>
      ) : null}

      <section className="flex flex-col gap-6">
        <TabBar tabs={tabs.map((entry) => ({ ...entry, count: tabCounts[entry.id] ?? 0 }))} active={tab} onChange={setTab} label="Job filters" />
        <DataTable
          caption="Jobs"
          columns={columns}
          rows={filtered}
          rowKey={({ job }) => job.id.toString()}
          empty={
            jobsQuery.isPending ? (
              <EmptyState title="Reading jobs from the chain" />
            ) : jobsQuery.isError ? (
              <EmptyState title="The chain read failed" hint={describeError(jobsQuery.error)} />
            ) : jobs.length === 0 ? (
              <EmptyState
                title="No jobs yet"
                hint="jobCounter is zero on this deployment."
                action={<PrimaryButton href="/new">Create the first job</PrimaryButton>}
              />
            ) : (
              <EmptyState title="No jobs match this filter" hint={`Nothing among the ${scanned} most recent jobs is in this state.`} />
            )
          }
        />
      </section>
    </div>
  );
}
