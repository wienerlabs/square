import type { JobPhase } from "@/lib/square";

export type Tone = "sky" | "amber" | "mint" | "magenta" | "neutral";

const tones: Record<Tone, { pill: string; dot: string }> = {
  sky: { pill: "bg-sky/10", dot: "bg-sky" },
  amber: { pill: "bg-amber/15", dot: "bg-amber" },
  mint: { pill: "bg-mint-wash", dot: "bg-mint" },
  magenta: { pill: "bg-magenta/10", dot: "bg-magenta" },
  neutral: { pill: "bg-mist", dot: "bg-ash" },
};

export const phaseTone: Record<JobPhase, Tone> = {
  open: "sky",
  funded: "sky",
  submitted: "amber",
  "in-window": "amber",
  finalizable: "amber",
  disputed: "magenta",
  completed: "mint",
  rejected: "magenta",
  expired: "neutral",
};

export const listingTone: Record<number, Tone> = { 0: "neutral", 1: "sky", 2: "mint", 3: "neutral" };
export const outcomeTone: Record<number, Tone> = { 0: "amber", 1: "mint", 2: "magenta", 3: "neutral" };

export function StatusPill({ label, tone, className = "" }: { label: string; tone: Tone; className?: string }) {
  const look = tones[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-caption font-medium text-carbon ${look.pill} ${className}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${look.dot}`} />
      {label}
    </span>
  );
}
