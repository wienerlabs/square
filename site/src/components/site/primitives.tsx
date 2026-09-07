import { ArrowRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/cn";

export function LogoMark({ className = "size-7" }: { className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#ffffff" />
        <rect x="28" y="28" width="44" height="44" rx="3.6" fill="#000000" />
      </mask>
      <g mask={`url(#${maskId})`} fill="currentColor">
        <rect x="6" y="6" width="66" height="66" rx="3.6" />
        <rect x="28" y="28" width="66" height="66" rx="3.6" />
      </g>
    </svg>
  );
}

export function PillButton({
  label,
  href,
  tone = "carbon",
  large = false,
  external = false,
}: {
  label: string;
  href: string;
  tone?: "carbon" | "lavender" | "white";
  large?: boolean;
  external?: boolean;
}) {
  const looks = {
    carbon: { pill: "bg-carbon text-paper-white hover:bg-carbon/85", disc: "bg-paper-white", arrow: "text-carbon" },
    lavender: { pill: "bg-lavender text-carbon hover:bg-lavender/85", disc: "bg-carbon", arrow: "text-paper-white" },
    white: { pill: "bg-paper-white text-carbon hover:bg-paper-white/90", disc: "bg-carbon", arrow: "text-paper-white" },
  }[tone];
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cn(
        "group inline-flex items-center gap-3 rounded-full py-2 pl-7 pr-2 font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender",
        large ? "text-base md:text-lg" : "text-base",
        looks.pill,
      )}
    >
      <span>{label}</span>
      <span className={cn("rounded-full p-2 transition-transform duration-200 group-hover:translate-x-0.5", looks.disc)}>
        <ArrowRight className={cn("size-5", looks.arrow)} />
      </span>
    </a>
  );
}

export function TextLink({ href, children, external = false, className = "" }: { href: string; children: ReactNode; external?: boolean; className?: string }) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cn("text-base font-medium text-carbon underline decoration-fog underline-offset-4 transition-colors hover:decoration-carbon", className)}
    >
      {children}
    </a>
  );
}

export interface MarqueeItem {
  name: string;
  detail?: string;
  style?: CSSProperties;
}

export function Marquee({
  items,
  trackClass,
  keyframesName,
  durationSeconds,
  itemClass,
}: {
  items: MarqueeItem[];
  trackClass: string;
  keyframesName: string;
  durationSeconds: number;
  itemClass: string;
}) {
  return (
    <>
      <style>{`
        @keyframes ${keyframesName} {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .${trackClass} {
          display: flex;
          width: max-content;
          animation: ${keyframesName} ${durationSeconds}s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .${trackClass} { animation: none; }
        }
      `}</style>
      <div className={trackClass} aria-hidden="true">
        {[...items, ...items].map((item, index) => (
          <span key={`${item.name}-${index}`} className={itemClass} style={item.style}>
            <span className="font-medium text-carbon">{item.name}</span>
            {item.detail ? <span className="ml-2 text-graphite">{item.detail}</span> : null}
          </span>
        ))}
      </div>
    </>
  );
}
