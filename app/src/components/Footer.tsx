import Link from "next/link";
import { Logo } from "./Logo";
import { ArcNetworkMark } from "./marks";
import { activeChain, DOCS_URL, explorerUrl, REPO_URL, rpcUrl, SITE_URL } from "@/lib/wagmi";

const columnTitle = "text-caption font-medium text-carbon";
const item = "text-caption text-graphite transition-colors hover:text-carbon";

export function Footer() {
  return (
    <footer className="border-t border-fog bg-linen">
      <div className="mx-auto grid w-full max-w-[1200px] gap-8 px-6 py-12 md:grid-cols-4">
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-body font-medium text-carbon">
            <Logo className="size-5 text-carbon" />
            Square
          </p>
          <p className="max-w-xs text-caption text-graphite">
            Compliance-gated settlement for autonomous agent work on Arc. Pre-alpha; nothing here carries an assurance claim.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <p className={columnTitle}>Product</p>
          <a href={SITE_URL} className={item}>
            Website
          </a>
          <Link href="/dashboard" className={item}>
            Dashboard
          </Link>
          <Link href="/new" className={item}>
            New job
          </Link>
          <Link href="/network" className={item}>
            Network
          </Link>
        </div>
        <div className="flex flex-col gap-3">
          <p className={columnTitle}>Protocol</p>
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className={item}>
            Design notes
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={item}>
            Source on GitHub
          </a>
          {explorerUrl ? (
            <a href={explorerUrl} target="_blank" rel="noreferrer" className={item}>
              Explorer
            </a>
          ) : null}
        </div>
        <div className="flex flex-col gap-3">
          <p className={columnTitle}>Network</p>
          <p className="flex items-center gap-2 text-caption text-graphite">
            {activeChain.id === 5042002 ? <ArcNetworkMark className="size-4" /> : null}
            {activeChain.name}
          </p>
          <p className="text-caption tabular-nums text-graphite">Chain id {activeChain.id}</p>
          <p className="break-all text-caption text-graphite">{rpcUrl}</p>
        </div>
      </div>
      <div className="border-t border-fog">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-2 px-6 py-4 text-caption text-ash">
          <span>Apache-2.0. Font: Open Runde, SIL Open Font License 1.1. Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.</span>
          <span>Wiener Labs</span>
        </div>
      </div>
    </footer>
  );
}
