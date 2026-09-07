"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";
import { DOCS_URL } from "@/lib/wagmi";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/new", label: "New job" },
  { href: "/network", label: "Network" },
];

const linkClass =
  "inline-flex h-9 items-center rounded-full px-3.5 text-caption font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender";

export function NavPill() {
  const pathname = usePathname();
  return (
    <header className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <nav
        aria-label="Primary"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-fog bg-paper-white p-1.5 shadow-subtle-2"
      >
        <Link href="/" className={`${linkClass} gap-2 pl-3 text-carbon`}>
          <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-carbon" />
          Square
        </Link>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-fog" />
        {links.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`${linkClass} ${active ? "bg-mist text-carbon" : "text-graphite hover:bg-linen hover:text-carbon"}`}
            >
              {link.label}
            </Link>
          );
        })}
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className={`${linkClass} text-graphite hover:bg-linen hover:text-carbon`}>
          Docs
        </a>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-fog" />
        <WalletButton />
      </nav>
    </header>
  );
}
