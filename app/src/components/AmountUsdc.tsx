import { formatUsdc } from "@/lib/format";
import { UsdcMark } from "./marks";

export function AmountUsdc({
  value,
  className = "",
  unit = true,
  mark = true,
}: {
  value: bigint;
  className?: string;
  unit?: boolean;
  mark?: boolean;
}) {
  return (
    <span className={`tabular-nums ${className}`}>
      {formatUsdc(value)}
      {unit ? (
        <span className="text-ash">
          {" "}
          {mark ? <UsdcMark className="mr-1 size-3.5" /> : null}
          USDC
        </span>
      ) : null}
    </span>
  );
}
