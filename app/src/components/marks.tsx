export function UsdcMark({ className = "size-3.5" }: { className?: string }) {
  return <img src="/brand/usdc.svg" alt="" aria-hidden="true" width={14} height={14} className={`inline-block shrink-0 align-[-0.125em] ${className}`} />;
}

export function ArcNetworkMark({ className = "size-4" }: { className?: string }) {
  return <img src="/brand/arc-network.svg" alt="" aria-hidden="true" width={16} height={16} className={`inline-block shrink-0 rounded-full align-[-0.15em] ${className}`} />;
}

export function ArcLogo({ tone = "black", height = 50 }: { tone?: "black" | "white"; height?: number }) {
  const width = Math.round((height * 500) / 171);
  return <img src={`/brand/arc-logo-${tone}.svg`} alt="Arc" width={width} height={height} style={{ height, width }} className="shrink-0" />;
}

export function BuiltOnArc() {
  return (
    <a
      href="https://www.arc.io"
      target="_blank"
      rel="noreferrer"
      aria-label="Built on Arc"
      className="inline-flex items-center gap-4 rounded-full py-3 pl-4 pr-4 text-caption text-graphite transition-colors hover:text-carbon focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender"
      style={{ paddingTop: 18, paddingBottom: 18 }}
    >
      <span>Built on</span>
      <ArcLogo height={50} />
    </a>
  );
}
