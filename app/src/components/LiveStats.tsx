"use client";

import { MetricCard } from "@/components/MetricCard";
import { UsdcMark } from "@/components/marks";
import { formatBigint, formatUsdc } from "@/lib/format";
import { useJobs, useNow } from "@/lib/square";
import { liveStats, relativeTime } from "@/lib/stats";
import { describeError } from "@/lib/tx";

export function LiveStats() {
  const jobs = useJobs();
  const now = useNow(30_000);
  const stats = jobs.data ? liveStats(jobs.data) : null;
  const unavailable = jobs.isError ? "Unavailable" : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Jobs opened" loading={jobs.isPending} value={stats ? formatBigint(stats.totalJobs) : unavailable ?? "0"} hint="jobCounter on SquareJob" />
        <MetricCard
          label={
            <>
              <UsdcMark className="size-3.5" />
              USDC in escrow
            </>
          }
          loading={jobs.isPending}
          value={stats ? formatUsdc(stats.escrowed) : unavailable ?? "0"}
          hint={stats ? `Still held on funded and submitted jobs, of the ${stats.scanned} most recent` : undefined}
        />
        <MetricCard
          label="Settled"
          loading={jobs.isPending}
          value={stats ? `${stats.completed} ${stats.completed === 1 ? "job" : "jobs"}` : unavailable ?? "0"}
          hint={stats ? `${formatUsdc(stats.settled)} USDC released to payees, net of the fees snapshotted at funding` : undefined}
        />
        <MetricCard
          label="Last activity"
          loading={jobs.isPending}
          value={stats ? (stats.lastActivity ? relativeTime(stats.lastActivity, now) : "None yet") : unavailable ?? "None yet"}
          hint={stats ? `${stats.active} ${stats.active === 1 ? "job" : "jobs"} funded or under review` : undefined}
        />
      </div>
      {jobs.isError ? <p className="text-caption text-graphite">The chain read failed: {describeError(jobs.error)}</p> : null}
    </div>
  );
}
