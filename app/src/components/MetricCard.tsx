import type { ReactNode } from "react";

export function MetricCard({ label, value, hint, loading = false }: { label: string; value: ReactNode; hint?: string; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-fog bg-paper-white p-8">
      <p className="text-caption text-graphite">{label}</p>
      {loading ? (
        <div aria-label="Loading" className="mt-3 h-7 w-20 rounded-full bg-mist" />
      ) : (
        <p className="mt-2 text-heading-sm font-medium tabular-nums text-carbon">{value}</p>
      )}
      {hint ? <p className="mt-2 text-caption text-ash">{hint}</p> : null}
    </div>
  );
}
