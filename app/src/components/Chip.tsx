import type { ReactNode } from "react";

export type DotTone = "mint" | "amber" | "sky" | "magenta" | "ash";

const dots: Record<DotTone, string> = {
  mint: "bg-mint",
  amber: "bg-amber",
  sky: "bg-sky",
  magenta: "bg-magenta",
  ash: "bg-ash",
};

export function Chip({ children, dot, className = "" }: { children: ReactNode; dot?: DotTone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-fog bg-paper-white px-3 py-1 text-caption font-medium text-carbon ${className}`}
    >
      {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${dots[dot]}`} /> : null}
      {children}
    </span>
  );
}
