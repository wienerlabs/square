import { chartColors } from "@/lib/charts";

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  display: string;
}

export function SegmentBar({
  segments,
  total,
  remainderLabel,
  remainderDisplay,
  ariaLabel,
}: {
  segments: Segment[];
  total: number;
  remainderLabel?: string;
  remainderDisplay?: string;
  ariaLabel: string;
}) {
  const used = segments.reduce((sum, segment) => sum + segment.value, 0);
  const scale = total > 0 ? total : used > 0 ? used : 1;
  let offset = 0;
  const rects = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const x = (offset / scale) * 100;
      const width = (segment.value / scale) * 100;
      offset += segment.value;
      return { ...segment, x, width };
    });
  const remainder = Math.max(0, scale - used);
  return (
    <div className="flex flex-col gap-3">
      <svg role="img" aria-label={ariaLabel} viewBox="0 0 100 12" preserveAspectRatio="none" className="h-3 w-full overflow-visible">
        <rect x="0" y="0" width="100" height="12" rx="6" fill={chartColors.mist} />
        {rects.map((rect) => (
          <rect key={rect.key} x={rect.x} y="0" width={rect.width} height="12" fill={rect.color}>
            <title>{`${rect.label}: ${rect.display}`}</title>
          </rect>
        ))}
        <rect x="0" y="0" width="100" height="12" rx="6" fill="none" stroke={chartColors.fog} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2 text-caption text-graphite">
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
            <span>{segment.label}</span>
            <span className="tabular-nums text-carbon">{segment.display}</span>
          </li>
        ))}
        {remainderLabel && remainder > 0 ? (
          <li className="flex items-center gap-2 text-caption text-graphite">
            <span aria-hidden="true" className="size-1.5 rounded-full border border-fog bg-mist" />
            <span>{remainderLabel}</span>
            {remainderDisplay ? <span className="tabular-nums text-carbon">{remainderDisplay}</span> : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
