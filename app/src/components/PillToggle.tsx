"use client";

import type { ReactNode } from "react";

export function PillToggle({
  selected,
  onClick,
  children,
  className = "",
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-caption font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender ${
        selected ? "border-carbon bg-carbon text-paper-white" : "border-fog bg-paper-white text-graphite hover:border-ash hover:text-carbon"
      } ${className}`}
    >
      {children}
    </button>
  );
}
