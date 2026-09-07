"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { chartColors, chartFont, formatCompactUsdc, type PhaseSlice } from "@/lib/charts";
import { ChartFrame, ChartPlaceholder } from "./ChartFrame";

const HEIGHT = 240;

function PipelineTooltip({ active, payload }: { active?: boolean; payload?: { payload: PhaseSlice }[] }) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) return null;
  return (
    <div className="rounded-xl border border-fog bg-paper-white px-4 py-3 shadow-subtle-2">
      <p className="text-caption font-medium text-carbon">{slice.label}</p>
      <p className="text-caption tabular-nums text-graphite">
        {slice.count} {slice.count === 1 ? "job" : "jobs"}, {formatCompactUsdc(slice.budget)} USDC in budgets
      </p>
    </div>
  );
}

export function PipelineChart({ slices, scanned, loading }: { slices: PhaseSlice[]; scanned: number; loading: boolean }) {
  return (
    <ChartFrame
      title="Pipeline by phase"
      description="Budget held in each phase, with the number of jobs on top."
      caption={`Phases are derived from status, the challenge window and the dispute flag of the ${scanned} most recent jobs, at the current block time.`}
    >
      {loading ? (
        <ChartPlaceholder height={HEIGHT} label="Reading job records from the chain" />
      ) : slices.length === 0 ? (
        <ChartPlaceholder height={HEIGHT} label="No jobs yet" />
      ) : (
        <div style={{ height: HEIGHT }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={slices} margin={{ top: 24, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
              <CartesianGrid stroke={chartColors.fog} vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                tick={{ fill: chartColors.graphite, fontSize: 12, fontFamily: chartFont }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(value: number) => formatCompactUsdc(value)}
                tick={{ fill: chartColors.ash, fontSize: 12, fontFamily: chartFont }}
              />
              <Tooltip cursor={{ fill: chartColors.mist }} content={<PipelineTooltip />} />
              <Bar dataKey="budget" radius={[8, 8, 8, 8]} maxBarSize={44} isAnimationActive={false}>
                {slices.map((slice) => (
                  <Cell key={slice.phase} fill={slice.color} />
                ))}
                <LabelList
                  dataKey="count"
                  position="top"
                  offset={8}
                  style={{ fill: chartColors.carbon, fontSize: 12, fontFamily: chartFont, fontWeight: 500 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartFrame>
  );
}
