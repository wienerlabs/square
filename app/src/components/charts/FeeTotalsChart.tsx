"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { chartColors, chartFont, formatCompactUsdc, type FeeTotals } from "@/lib/charts";
import { ChartFrame, ChartPlaceholder } from "./ChartFrame";

const HEIGHT = 220;

interface Row {
  key: string;
  label: string;
  value: number;
  color: string;
}

function FeeTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-xl border border-fog bg-paper-white px-4 py-3 shadow-subtle-2">
      <p className="text-caption font-medium text-carbon">{row.label}</p>
      <p className="text-caption tabular-nums text-graphite">{formatCompactUsdc(row.value)} USDC</p>
    </div>
  );
}

export function FeeTotalsChart({ totals, scanned, loading, error }: { totals: FeeTotals | null; scanned: number; loading: boolean; error?: string | null }) {
  const rows: Row[] = totals
    ? [
        { key: "net", label: "Paid to payees", value: totals.netPaid, color: chartColors.lavender },
        { key: "platform", label: "Platform fees", value: totals.platform, color: chartColors.carbon },
        { key: "evaluator", label: "Evaluator fees", value: totals.evaluator, color: chartColors.amber },
        { key: "refunded", label: "Refunded", value: totals.refunded, color: chartColors.magenta },
      ]
    : [];
  const nothing = totals !== null && totals.completed === 0 && totals.rejected === 0;
  return (
    <ChartFrame
      title="Settled on recent jobs"
      description="Where escrowed USDC went on the jobs that reached a terminal status."
      caption={
        totals
          ? `${totals.completed} completed and ${totals.rejected} rejected among the ${scanned} most recent jobs. Fees are the snapshotted basis points applied to each budget; the kernel keeps per-account balances, not per-job settlement rows.`
          : `Computed over the ${scanned} most recent job records.`
      }
    >
      {loading ? (
        <ChartPlaceholder height={HEIGHT} label="Reading job records from the chain" />
      ) : error ? (
        <ChartPlaceholder height={HEIGHT} tone="error" label={`The chain read failed: ${error}`} />
      ) : nothing ? (
        <ChartPlaceholder height={HEIGHT} label="No job has settled yet" />
      ) : (
        <div style={{ height: HEIGHT }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 4 }} barCategoryGap="26%">
              <CartesianGrid stroke={chartColors.fog} horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={112}
                tick={{ fill: chartColors.graphite, fontSize: 12, fontFamily: chartFont }}
              />
              <Tooltip cursor={{ fill: chartColors.mist }} content={<FeeTooltip />} />
              <Bar dataKey="value" radius={[7, 7, 7, 7]} barSize={12} isAnimationActive={false}>
                {rows.map((row) => (
                  <Cell key={row.key} fill={row.color} />
                ))}
                <LabelList
                  dataKey="value"
                  position="right"
                  offset={8}
                  formatter={(value) => `${formatCompactUsdc(Number(value))} USDC`}
                  style={{ fill: chartColors.carbon, fontSize: 12, fontFamily: chartFont }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  );
}
