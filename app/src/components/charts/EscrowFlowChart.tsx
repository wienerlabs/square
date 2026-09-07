"use client";

import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { chartColors, chartFont, DAY, formatCompactUsdc, HOUR, type FlowPoint, type FlowSeries } from "@/lib/charts";
import { ChartFrame, ChartPlaceholder } from "./ChartFrame";

const HEIGHT = 260;

function tickLabel(time: number, bucket: number): string {
  const date = new Date(time * 1000);
  if (bucket >= DAY) return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fullLabel(time: number, bucket: number): string {
  const date = new Date(time * 1000);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  if (bucket >= DAY) return day;
  const from = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const to = new Date((time + bucket) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${from} to ${to}`;
}

function FlowTooltip({ active, payload, bucket }: { active?: boolean; payload?: { payload: FlowPoint }[]; bucket: number }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-xl border border-fog bg-paper-white px-4 py-3 shadow-subtle-2">
      <p className="text-caption font-medium text-carbon">{fullLabel(point.time, bucket)}</p>
      <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-caption">
        <dt className="text-graphite">Funded</dt>
        <dd className="tabular-nums text-carbon">{formatCompactUsdc(point.funded)} USDC</dd>
        <dt className="text-graphite">Submitted</dt>
        <dd className="tabular-nums text-carbon">{formatCompactUsdc(point.submitted)} USDC</dd>
        <dt className="text-graphite">Funded so far</dt>
        <dd className="tabular-nums text-carbon">{formatCompactUsdc(point.cumulativeFunded)} USDC</dd>
        <dt className="text-graphite">Submitted so far</dt>
        <dd className="tabular-nums text-carbon">{formatCompactUsdc(point.cumulativeSubmitted)} USDC</dd>
      </dl>
    </div>
  );
}

export function EscrowFlowChart({ series, scanned, loading, error }: { series: FlowSeries | null; scanned: number; loading: boolean; error?: string | null }) {
  const bucketLabel = series?.bucket === HOUR ? "hour" : "day";
  return (
    <ChartFrame
      title="Escrow flow"
      description={`USDC entering escrow per ${bucketLabel}, with the running totals funded and submitted.`}
      legend={[
        { label: "Funded", color: chartColors.lavender, value: series ? `${formatCompactUsdc(series.totalFunded)} USDC` : undefined },
        { label: "Cumulative funded", color: chartColors.carbon },
        { label: "Cumulative submitted", color: chartColors.sky, dashed: true, value: series ? `${formatCompactUsdc(series.totalSubmitted)} USDC` : undefined },
      ]}
      caption={`Built from the fundedAt and submittedAt timestamps of the ${scanned} most recent job records, in your local time.`}
    >
      {loading ? (
        <ChartPlaceholder height={HEIGHT} label="Reading job records from the chain" />
      ) : error ? (
        <ChartPlaceholder height={HEIGHT} tone="error" label={`The chain read failed: ${error}`} />
      ) : !series || series.points.length === 0 ? (
        <ChartPlaceholder height={HEIGHT} label="No job has been funded yet" />
      ) : (
        <div style={{ height: HEIGHT }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series.points} margin={{ top: 12, right: 12, left: 0, bottom: 0 }} barCategoryGap="45%">
              <defs>
                <linearGradient id="escrow-flow-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColors.lavender} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={chartColors.lavender} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={chartColors.fog} vertical={false} />
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tickFormatter={(value: number) => tickLabel(value, series.bucket)}
                tick={{ fill: chartColors.graphite, fontSize: 12, fontFamily: chartFont }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value: number) => formatCompactUsdc(value)}
                tick={{ fill: chartColors.ash, fontSize: 12, fontFamily: chartFont }}
              />
              <Tooltip cursor={{ fill: chartColors.mist }} content={<FlowTooltip bucket={series.bucket} />} />
              <Area
                type="monotone"
                dataKey="cumulativeFunded"
                stroke="none"
                fill="url(#escrow-flow-fill)"
                isAnimationActive={false}
                activeDot={false}
              />
              <Bar dataKey="funded" fill={chartColors.lavender} radius={[6, 6, 6, 6]} barSize={10} isAnimationActive={false} />
              <Line
                type="monotone"
                dataKey="cumulativeFunded"
                stroke={chartColors.carbon}
                strokeWidth={2}
                dot={{ r: 3, fill: chartColors.paper, stroke: chartColors.carbon, strokeWidth: 2 }}
                activeDot={{ r: 4, fill: chartColors.carbon, stroke: chartColors.paper, strokeWidth: 2 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="cumulativeSubmitted"
                stroke={chartColors.sky}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4, fill: chartColors.sky, stroke: chartColors.paper, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  );
}
