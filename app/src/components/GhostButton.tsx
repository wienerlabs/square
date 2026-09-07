"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ButtonSize } from "./PrimaryButton";

const sizes: Record<ButtonSize, string> = {
  md: "h-11 px-5 text-body",
  sm: "h-9 px-4 text-caption",
};

const base =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  href?: string;
  external?: boolean;
  size?: ButtonSize;
  children: ReactNode;
}

export function GhostButton({ href, external, size = "md", className = "", children, disabled, ...rest }: Props) {
  const look = disabled
    ? "cursor-not-allowed border-fog bg-mist text-ash"
    : "border-fog bg-paper-white text-carbon hover:bg-linen";
  const classes = `${base} ${sizes[size]} ${look} ${className}`;
  if (href && !disabled) {
    if (external) {
      return (
        <a href={href} className={classes} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={classes} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
