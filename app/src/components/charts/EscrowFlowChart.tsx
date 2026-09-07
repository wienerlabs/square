"use client";

import { ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { chartColors, chartFont, formatCompactUsdc, HOUR, type FlowSeries } from "@/lib/charts";
import { ChartFrame, ChartPlaceholder } from "./ChartFrame";

const HEIGHT = 260;

function Canvas({ series }: { series: FlowSeries }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: chartColors.paper },
        textColor: chartColors.graphite,
        fontFamily: chartFont,
        fontSize: 12,
        attributionLogo: false,
      },
      grid: { vertLines: { color: chartColors.fog }, horzLines: { color: chartColors.fog } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.04 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: chartColors.lavender, width: 1, style: LineStyle.Solid, labelBackgroundColor: chartColors.carbon },
        horzLine: { color: chartColors.lavender, width: 1, style: LineStyle.Solid, labelBackgroundColor: chartColors.carbon },
      },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: (price: number) => `${formatCompactUsdc(price)} USDC` },
    });
    const funded = chart.addSeries(HistogramSeries, {
      color: chartColors.lavender,
      priceFormat: { type: "custom", formatter: (price: number) => formatCompactUsdc(price), minMove: 0.000001 },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const cumulativeFunded = chart.addSeries(LineSeries, {
      color: chartColors.carbon,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: (price: number) => formatCompactUsdc(price), minMove: 0.000001 },
    });
    const cumulativeSubmitted = chart.addSeries(LineSeries, {
      color: chartColors.sky,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: (price: number) => formatCompactUsdc(price), minMove: 0.000001 },
    });
    const stamp = (time: number) => time as UTCTimestamp;
    funded.setData(series.points.map((point) => ({ time: stamp(point.time), value: point.funded })));
    cumulativeFunded.setData(series.points.map((point) => ({ time: stamp(point.time), value: point.cumulativeFunded })));
    cumulativeSubmitted.setData(series.points.map((point) => ({ time: stamp(point.time), value: point.cumulativeSubmitted })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);

  return <div ref={container} style={{ height: HEIGHT }} className="w-full" />;
}

export function EscrowFlowChart({ series, scanned, loading }: { series: FlowSeries | null; scanned: number; loading: boolean }) {
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
      caption={
        <>
          Built from the fundedAt and submittedAt timestamps of the {scanned} most recent job records. Times are UTC. Chart by TradingView Lightweight Charts.
        </>
      }
    >
      {loading ? (
        <ChartPlaceholder height={HEIGHT} label="Reading job records from the chain" />
      ) : !series || series.points.length === 0 ? (
        <ChartPlaceholder height={HEIGHT} label="No job has been funded yet" />
      ) : (
        <Canvas series={series} />
      )}
    </ChartFrame>
  );
}
