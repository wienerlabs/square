import { APP_URL, DOCS_URL, REPO_URL } from "@/lib/links";
import { LogoMark } from "./primitives";

const NAV_LINKS = [
  { label: "Protocol", href: "#protocol" },
  { label: "Standards", href: "#standards" },
  { label: "Modes", href: "#modes" },
  { label: "Docs", href: DOCS_URL, external: true },
  { label: "GitHub", href: REPO_URL, external: true },
];

export function Navbar() {
  return (
    <nav className="absolute inset-x-0 top-0 z-20 px-6 py-5" aria-label="Primary">
      <div className="mx-auto flex max-w-[88rem] items-center justify-between">
        <a href="#top" aria-label="Square home" className="flex items-center gap-2.5">
          <LogoMark className="size-7 text-carbon" />
          <span className="text-2xl font-medium tracking-tight text-carbon">Square</span>
        </a>

        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              className="text-base font-medium text-graphite transition-colors duration-200 hover:text-carbon"
            >
              {link.label}
            </a>
          ))}
        </div>

        <a
          href={APP_URL}
          className="rounded-full bg-carbon px-7 py-2.5 text-base font-medium text-paper-white transition-colors duration-200 hover:bg-carbon/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender"
        >
          Open the app
        </a>
      </div>
    </nav>
  );
}
