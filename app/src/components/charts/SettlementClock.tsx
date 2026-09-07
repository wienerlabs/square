import { chartColors, clusterMarks, type SettlementClock as Clock } from "@/lib/charts";
import { formatDuration, formatTimestamp } from "@/lib/format";

const WIDTH = 100;
const TRACK_Y = 34;
const TRACK_H = 14;

function shortStamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function SettlementClock({ clock }: { clock: Clock }) {
  const span = Math.max(1, clock.end - clock.start);
  const position = (at: number) => Math.min(WIDTH, Math.max(0, ((at - clock.start) / span) * WIDTH));
  const nowInside = clock.now >= clock.start && clock.now <= clock.end;
  const nowX = position(clock.now);
  const marks = clock.marks.map((mark) => ({ ...mark, x: position(mark.at) }));
  const labels = clusterMarks(marks);

  return (
    <div className="flex flex-col gap-4">
      <svg role="img" aria-label="Settlement clock" viewBox={`0 0 ${WIDTH} 96`} preserveAspectRatio="none" className="h-24 w-full overflow-visible">
        <rect x="0" y={TRACK_Y} width={WIDTH} height={TRACK_H} rx="7" fill={chartColors.mist} />
        {clock.segments.map((segment) => {
          const x = position(segment.from);
          const width = Math.max(0.4, position(segment.to) - x);
          return (
            <g key={segment.key}>
              <rect x={x} y={TRACK_Y} width={width} height={TRACK_H} fill={segment.color} opacity={segment.state === "future" ? 0.25 : segment.state === "live" ? 0.9 : 0.55}>
                <title>{`${segment.label}: ${formatTimestamp(segment.from)} to ${formatTimestamp(segment.to)} (${formatDuration(segment.to - segment.from)})`}</title>
              </rect>
              {segment.state === "live" ? (
                <rect x={x} y={TRACK_Y} width={width} height={TRACK_H} fill="none" stroke={segment.color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
              ) : null}
            </g>
          );
        })}
        <rect x="0" y={TRACK_Y} width={WIDTH} height={TRACK_H} rx="7" fill="none" stroke={chartColors.fog} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        {labels.map((label) => (
          <line
            key={label.key}
            x1={label.x}
            x2={label.x}
            y1={label.row === 0 ? TRACK_Y - 10 : TRACK_Y + TRACK_H}
            y2={label.row === 0 ? TRACK_Y : TRACK_Y + TRACK_H + 10}
            stroke={label.emphasis ? chartColors.magenta : chartColors.carbon}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {nowInside ? (
          <line x1={nowX} x2={nowX} y1={TRACK_Y - 16} y2={TRACK_Y + TRACK_H + 16} stroke={chartColors.lavender} strokeWidth="2" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="relative h-16 w-full">
        {labels.map((label) => (
          <div
            key={label.key}
            className="absolute flex w-36 flex-col text-center"
            style={{ left: `${label.x}%`, top: label.row === 0 ? 0 : 32, transform: label.x < 10 ? "translateX(-8%)" : label.x > 90 ? "translateX(-92%)" : "translateX(-50%)" }}
          >
            <span className={`text-caption font-medium ${label.emphasis ? "text-magenta" : "text-carbon"}`}>{label.names.join(", ")}</span>
            <span className="text-caption tabular-nums text-ash">{shortStamp(label.at)}</span>
          </div>
        ))}
      </div>
      {!clock.expiryOnScale ? (
        <p className="text-caption text-ash">Expires {formatTimestamp(clock.expiresAt)}, beyond the scale of this clock.</p>
      ) : null}
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {clock.segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2 text-caption text-graphite">
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
            <span>{segment.label}</span>
            <span className="tabular-nums text-carbon">{formatDuration(segment.to - segment.from)}</span>
            {segment.state === "live" ? <span className="text-lavender">live</span> : null}
          </li>
        ))}
        {nowInside ? (
          <li className="flex items-center gap-2 text-caption text-graphite">
            <span aria-hidden="true" className="inline-block h-[3px] w-4 rounded-full" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${chartColors.lavender} 0 4px, transparent 4px 7px)` }} />
            <span>Now</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
