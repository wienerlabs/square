import { formatUsdc } from "@/lib/format";

export function AmountUsdc({ value, className = "", unit = true }: { value: bigint; className?: string; unit?: boolean }) {
  return (
    <span className={`tabular-nums ${className}`}>
      {formatUsdc(value)}
      {unit ? <span className="text-ash"> USDC</span> : null}
    </span>
  );
}
