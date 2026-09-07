import type { ReactNode } from "react";

export interface LegendItem {
  label: string;
  color: string;
  value?: string;
  dashed?: boolean;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-caption text-graphite">
          <span
            aria-hidden="true"
            className="inline-block h-[3px] w-4 rounded-full"
            style={item.dashed ? { backgroundImage: `repeating-linear-gradient(90deg, ${item.color} 0 4px, transparent 4px 7px)` } : { backgroundColor: item.color }}
          />
          <span>{item.label}</span>
          {item.value ? <span className="tabular-nums text-carbon">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function ChartFrame({
  title,
  description,
  legend,
  caption,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  legend?: LegendItem[];
  caption?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`flex flex-col gap-4 rounded-2xl border border-fog bg-paper-white p-6 ${className}`}>
      <figcaption className="flex flex-col gap-1">
        <span className="text-body font-medium text-carbon">{title}</span>
        {description ? <span className="text-caption text-graphite">{description}</span> : null}
      </figcaption>
      {legend ? <Legend items={legend} /> : null}
      {children}
      {caption ? <p className="text-caption text-ash">{caption}</p> : null}
    </figure>
  );
}

export function ChartPlaceholder({ height = 240, label }: { height?: number; label: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center rounded-xl border border-dashed border-fog bg-linen text-caption text-ash"
      style={{ height }}
    >
      {label}
    </div>
  );
}
