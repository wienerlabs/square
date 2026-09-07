"use client";

import Link from "next/link";
import type { Address } from "viem";
import { AmountUsdc } from "@/components/AmountUsdc";
import { PanelCard } from "@/components/PanelCard";
import { StatusPill, phaseTone } from "@/components/StatusPill";
import { formatCountdown, formatTimestamp } from "@/lib/format";
import { walletInbox, walletJobCount } from "@/lib/inbox";
import { jobPhase, PHASE_LABELS, type JobSummary } from "@/lib/square";

export function ActionInbox({ jobs, address, now, scanned }: { jobs: JobSummary[]; address: Address; now: number; scanned: number }) {
  const groups = walletInbox(jobs, address, now);
  const mine = walletJobCount(jobs, address);
  const pending = groups.reduce((sum, group) => sum + group.jobs.length, 0);

  return (
    <PanelCard
      title="Your jobs"
      description={
        mine === 0
          ? `The connected wallet is not the client or the provider of any of the ${scanned} most recent jobs.`
          : pending === 0
            ? `${mine} of the ${scanned} most recent jobs involve this wallet. Nothing waits on you right now.`
            : `${pending} of your ${mine} jobs among the ${scanned} most recent ${pending === 1 ? "waits" : "wait"} on a step you can take.`
      }
    >
      {groups.length === 0 ? null : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <section key={group.kind} className="flex flex-col gap-3 rounded-2xl border border-fog p-6">
              <div>
                <h3 className="text-body font-medium text-carbon">
                  {group.title}
                  <span className="ml-2 rounded-full bg-mist px-2 py-0.5 text-caption tabular-nums text-graphite">{group.jobs.length}</span>
                </h3>
                <p className="mt-1 text-caption text-graphite">{group.body}</p>
              </div>
              <ul className="flex flex-col divide-y divide-fog">
                {group.jobs.slice(0, 5).map((job) => {
                  const phase = jobPhase(job, now);
                  return (
                    <li key={job.id.toString()} className="flex items-center justify-between gap-3 py-2.5">
                      <Link
                        href={`/job?id=${job.id.toString()}`}
                        className="font-medium tabular-nums text-carbon underline decoration-fog underline-offset-4 hover:decoration-carbon"
                      >
                        #{job.id.toString()}
                      </Link>
                      <span className="text-caption tabular-nums text-graphite">
                        {group.kind === "dispute" && job.challengeEnd > 0
                          ? formatCountdown(job.challengeEnd, now)
                          : group.kind === "submit" || group.kind === "fund" || group.kind === "budget"
                            ? `Expires ${formatTimestamp(job.expiredAt)}`
                            : ""}
                      </span>
                      <span className="flex items-center gap-3">
                        <AmountUsdc value={job.budget} className="text-caption" />
                        <StatusPill label={PHASE_LABELS[phase]} tone={phaseTone[phase]} />
                      </span>
                    </li>
                  );
                })}
                {group.jobs.length > 5 ? (
                  <li className="py-2 text-caption text-ash">And {group.jobs.length - 5} more in the table below.</li>
                ) : null}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PanelCard>
  );
}
