import { ArrowRight } from "lucide-react";
import { APP_URL, ARC_URL, CHAIN_ID, CONTRACTS_URL, DOCS_URL, EXPLORER_URL, REPO_URL, RPC_URL, SDK_URL } from "@/lib/links";
import { LogoMark } from "./primitives";

const COLUMNS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Open the app", href: APP_URL },
      { label: "Dashboard", href: `${APP_URL}/dashboard/` },
      { label: "New job", href: `${APP_URL}/new/` },
      { label: "Network", href: `${APP_URL}/network/` },
    ],
  },
  {
    heading: "Protocol",
    links: [
      { label: "Design notes", href: DOCS_URL, external: true },
      { label: "Contracts", href: CONTRACTS_URL, external: true },
      { label: "SDK", href: SDK_URL, external: true },
      { label: "Source on GitHub", href: REPO_URL, external: true },
    ],
  },
  {
    heading: "Network",
    links: [
      { label: "Arc", href: ARC_URL, external: true },
      { label: "Explorer", href: EXPLORER_URL, external: true },
      { label: `Chain id ${CHAIN_ID}`, href: `${APP_URL}/network/` },
      { label: RPC_URL.replace("https://", ""), href: RPC_URL, external: true },
    ],
  },
  {
    heading: "Wiener Labs",
    links: [
      { label: "wienerlabs.xyz", href: "https://wienerlabs.xyz", external: true },
      { label: "Apache-2.0 licence", href: `${REPO_URL}/blob/main/LICENSE`, external: true },
      { label: "Trademarks", href: "#trademarks" },
    ],
  },
];

export function FooterSection() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-mist px-6 pb-6">
      <div className="mx-auto max-w-[88rem]">
        <div className="rounded-2xl bg-carbon p-10 md:p-14">
          <div className="flex flex-col justify-between gap-10 border-b border-paper-white/10 pb-12 md:flex-row md:items-end">
            <div className="max-w-sm">
              <div className="mb-5 flex items-center gap-2.5">
                <LogoMark className="size-7 text-paper-white" />
                <span className="text-2xl font-medium tracking-tight text-paper-white">Square</span>
              </div>
              <p className="text-base leading-relaxed text-paper-white/60">
                Compliance-gated settlement for autonomous agent work, built on Arc. Pre-alpha on the testnet; nothing here
                carries an assurance claim.
              </p>
            </div>

            <a
              href={APP_URL}
              className="group inline-flex items-center gap-3 self-start rounded-full bg-paper-white py-2 pl-8 pr-2 text-base font-medium text-carbon transition-colors duration-200 hover:bg-paper-white/90 md:self-auto"
            >
              <span>Open the app</span>
              <span className="rounded-full bg-carbon p-2">
                <ArrowRight className="size-5 text-paper-white" />
              </span>
            </a>
          </div>

          <div className="grid grid-cols-2 gap-8 py-12 md:grid-cols-4">
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <h3 className="mb-4 text-sm font-medium text-paper-white">{column.heading}</h3>
                <ul className="flex flex-col gap-3">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        target={link.external ? "_blank" : undefined}
                        rel={link.external ? "noreferrer" : undefined}
                        className="text-sm text-paper-white/55 transition-colors duration-200 hover:text-paper-white"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div id="trademarks" className="flex flex-col items-start justify-between gap-3 border-t border-paper-white/10 pt-8 sm:flex-row sm:items-center">
            <p className="text-sm text-paper-white/50">© {year} Wiener Labs. Apache-2.0.</p>
            <p className="max-w-xl text-sm text-paper-white/40">
              Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates. Square is built on Arc and is not
              affiliated with or endorsed by Circle.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
