"use client";

import { clockSkew } from "@/lib/clock";
import { formatDuration } from "@/lib/format";
import { useClockSkew } from "@/lib/square";

export function ClockNotice() {
  const skew = clockSkew(useClockSkew());
  if (!skew) return null;
  return (
    <div role="status" className="mb-8 flex gap-3 rounded-2xl border border-fog bg-linen px-5 py-4">
      <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-amber" />
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium text-carbon">
          The clock in this browser runs {formatDuration(skew.seconds)} {skew.ahead ? "ahead of" : "behind"} the chain
        </p>
        <p className="text-caption text-graphite">
          Every countdown and every action on this site is measured from the latest block timestamp instead, so a step
          stays offered for as long as the chain accepts it. Set this machine to network time to make the two agree.
        </p>
      </div>
    </div>
  );
}
