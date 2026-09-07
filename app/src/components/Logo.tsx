import { useId } from "react";

export function Logo({ className = "size-4", title }: { className?: string; title?: string }) {
  const maskId = useId();
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
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
