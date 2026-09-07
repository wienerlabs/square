"use client";

import { AddressLink } from "./AddressLink";
import { formatBigint, formatDuration } from "@/lib/format";
import { useNetwork } from "@/lib/square";
import { describeError } from "@/lib/tx";
import { activeChain, deployment } from "@/lib/wagmi";

const contracts = [
  { label: "SquareJob", address: deployment.squareJob },
  { label: "KeeperEvaluator", address: deployment.keeperEvaluator },
  { label: "Arbitration", address: deployment.arbitration },
  { label: "ClaimMarket", address: deployment.claimMarket },
  { label: "SquareHook", address: deployment.squareHook },
];

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-caption text-graphite">{label}</span>
      <span className="text-body font-medium tabular-nums text-carbon">{children}</span>
    </div>
  );
}

function Skeleton() {
  return <span aria-label="Loading" className="inline-block h-4 w-16 rounded-full bg-mist align-middle" />;
}

export function NetworkStrip() {
  const network = useNetwork();
  const data = network.data;

  return (
    <div className="overflow-hidden rounded-2xl border border-fog bg-paper-white">
      <div className="grid divide-y divide-fog sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Cell label="Chain">
          {activeChain.name} <span className="text-graphite">({activeChain.id})</span>
        </Cell>
        <Cell label="Block">{data ? formatBigint(data.blockNumber) : network.isError ? "Unavailable" : <Skeleton />}</Cell>
        <Cell label="Settlement horizon">
          {data ? (
            <>
              {formatDuration(data.settlementHorizon)}{" "}
              <span className="text-graphite">({data.settlementHorizon} s from KeeperEvaluator)</span>
            </>
          ) : network.isError ? (
            "Unavailable"
          ) : (
            <Skeleton />
          )}
        </Cell>
      </div>
      <div className="grid divide-y divide-fog border-t border-fog sm:grid-cols-5 sm:divide-x sm:divide-y-0">
        {contracts.map((contract) => (
          <Cell key={contract.label} label={contract.label}>
            <AddressLink address={contract.address} />
          </Cell>
        ))}
      </div>
      {network.isError ? (
        <p className="border-t border-fog px-5 py-3 text-caption text-graphite">RPC read failed: {describeError(network.error)}</p>
      ) : null}
    </div>
  );
}
