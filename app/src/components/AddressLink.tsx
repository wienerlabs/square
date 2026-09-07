import { getAddress, isAddress } from "viem";
import { isZeroAddress, shortAddress, shortHash } from "@/lib/format";
import { explorerUrl } from "@/lib/wagmi";

const linkClass =
  "break-all tabular-nums text-carbon underline decoration-fog underline-offset-4 transition-colors hover:decoration-carbon";

export function AddressLink({ address, full = false, label }: { address: string; full?: boolean; label?: string }) {
  if (!isAddress(address) || isZeroAddress(address)) return <span className="text-ash">Not set</span>;
  const checksum = getAddress(address);
  const text = label ?? (full ? checksum : shortAddress(checksum));
  if (!explorerUrl) {
    return (
      <span className="break-all tabular-nums text-carbon" title={checksum}>
        {text}
      </span>
    );
  }
  return (
    <a href={`${explorerUrl}/address/${checksum}`} target="_blank" rel="noreferrer" className={linkClass} title={checksum}>
      {text}
    </a>
  );
}

export function TxLink({ hash, full = false }: { hash: string; full?: boolean }) {
  const text = full ? hash : shortHash(hash);
  if (!explorerUrl) {
    return (
      <span className="break-all tabular-nums text-carbon" title={hash}>
        {text}
      </span>
    );
  }
  return (
    <a href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer" className={linkClass} title={hash}>
      {text}
    </a>
  );
}
