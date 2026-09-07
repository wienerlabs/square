"use client";

import { AddressLink } from "@/components/AddressLink";
import { AmountUsdc } from "@/components/AmountUsdc";
import { EmptyState } from "@/components/EmptyState";
import { NetworkStrip } from "@/components/NetworkStrip";
import { PanelCard } from "@/components/PanelCard";
import { SectionHeading } from "@/components/SectionHeading";
import { formatBigint, formatBps, formatDuration, formatTimestamp, isZeroAddress } from "@/lib/format";
import { indexerUrl, useIndexerStatus } from "@/lib/indexer";
import { useNetwork } from "@/lib/square";
import { describeError } from "@/lib/tx";
import { activeChain, deployment, rpcUrl } from "@/lib/wagmi";

const docs = [
  { label: "Storage layout and event schema", href: "https://github.com/wienerlabs/square/blob/main/docs/design/storage-and-events.md" },
  { label: "SquareHook: one hook, selector routing", href: "https://github.com/wienerlabs/square/blob/main/docs/design/square-hook.md" },
  { label: "Data layer: one Postgres, chain is the source of truth", href: "https://github.com/wienerlabs/square/blob/main/docs/design/data-layer.md" },
  { label: "Keeper economics: why the crank is paid", href: "https://github.com/wienerlabs/square/blob/main/docs/design/keeper-economics.md" },
  { label: "ERC-20 versus native USDC", href: "https://github.com/wienerlabs/square/blob/main/docs/decisions/erc20-vs-native-usdc.md" },
  { label: "Gas, measured", href: "https://github.com/wienerlabs/square/blob/main/docs/deploy/gas.md" },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-fog py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-caption text-graphite">{label}</dt>
      <dd className="text-body tabular-nums text-carbon sm:text-right">{children}</dd>
    </div>
  );
}

export function NetworkView() {
  const network = useNetwork();
  const indexer = useIndexerStatus();
  const data = network.data;

  return (
    <div className="flex flex-col gap-16">
      <section className="flex flex-col gap-8">
        <SectionHeading title="Network" description={`Protocol parameters on ${activeChain.name}, read from the contracts every ten seconds.`} />
        <NetworkStrip />
      </section>

      {network.isError ? (
        <EmptyState title="The chain read failed" hint={describeError(network.error)} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <PanelCard title="Keeper windows" description="KeeperEvaluator.currentWindow; a job uses the entry in force at its submittedAt.">
            <dl>
              <Row label="Challenge window">{data ? `${formatDuration(data.window.challengeWindow)} (${data.window.challengeWindow} s)` : "Loading"}</Row>
              <Row label="Dispute window">{data ? `${formatDuration(data.window.disputeWindow)} (${data.window.disputeWindow} s)` : "Loading"}</Row>
              <Row label="Settlement horizon">{data ? `${formatDuration(data.settlementHorizon)} (${data.settlementHorizon} s)` : "Loading"}</Row>
              <Row label="Effective from">{data ? (data.window.effectiveFrom === 0 ? "Since deployment (0)" : formatTimestamp(data.window.effectiveFrom)) : "Loading"}</Row>
              <Row label="Arbitration wired">{data ? <AddressLink address={data.arbitrationAddress} /> : "Loading"}</Row>
            </dl>
          </PanelCard>

          <PanelCard title="Fees and treasury" description="Contract-wide values on SquareJob; each job snapshots them at funding.">
            <dl>
              <Row label="Platform fee">{data ? `${formatBps(data.platformFeeBP)} (${data.platformFeeBP} bp)` : "Loading"}</Row>
              <Row label="Evaluator fee">{data ? `${formatBps(data.evaluatorFeeBP)} (${data.evaluatorFeeBP} bp)` : "Loading"}</Row>
              <Row label="Combined cap">{data ? `${formatBps(data.maxTotalFeeBP)} (${data.maxTotalFeeBP.toString()} bp)` : "Loading"}</Row>
              <Row label="Treasury">{data ? <AddressLink address={data.treasury} /> : "Loading"}</Row>
              <Row label="Unclaimed on the ledger">{data ? <AmountUsdc value={data.totalWithdrawable} /> : "Loading"}</Row>
            </dl>
          </PanelCard>

          <PanelCard title="Arbiters" description="Arbitration.arbiterSet for the current version. Open disputes keep the version they were opened under.">
            <dl>
              <Row label="Set version">{data ? `v${data.arbiterVersion}` : "Loading"}</Row>
              <Row label="Threshold">{data ? `${data.threshold} of ${data.arbiters.length}` : "Loading"}</Row>
            </dl>
            {data ? (
              data.arbiters.length === 0 ? (
                <p className="mt-4 text-caption text-ash">No arbiters are configured; disputes cannot be opened.</p>
              ) : (
                <ol className="mt-4 flex flex-col gap-2">
                  {data.arbiters.map((arbiter, index) => (
                    <li key={arbiter} className="flex items-center gap-3 text-body">
                      <span className="w-6 text-caption tabular-nums text-ash">{index + 1}</span>
                      <AddressLink address={arbiter} full />
                    </li>
                  ))}
                </ol>
              )
            ) : null}
          </PanelCard>

          <PanelCard title="Bond parameters" description="Arbitration.bondParameters; a dispute bond is the larger of the proportional amount and the floor.">
            <dl>
              <Row label="Bond">{data ? `${formatBps(data.bondBps)} of the budget (${data.bondBps} bp)` : "Loading"}</Row>
              <Row label="Floor">{data ? <AmountUsdc value={data.minBond} /> : "Loading"}</Row>
            </dl>
          </PanelCard>

          <PanelCard title="Registries and token" description="Addresses from the SDK deployment table for this chain.">
            <dl>
              <Row label="USDC (ERC-20)">
                <AddressLink address={deployment.usdc} />
              </Row>
              <Row label="ERC-8004 Identity">
                <AddressLink address={deployment.identityRegistry} />
              </Row>
              <Row label="ERC-8004 Reputation">
                <AddressLink address={deployment.reputationRegistry} />
              </Row>
              <Row label="ERC-8004 Validation">
                <AddressLink address={deployment.validationRegistry} />
              </Row>
              <Row label="Compliance module">
                {data ? isZeroAddress(data.complianceModule) ? <span className="text-ash">Not installed; the hook slot is open</span> : <AddressLink address={data.complianceModule} /> : "Loading"}
              </Row>
            </dl>
          </PanelCard>

          <PanelCard title="Read path" description="Where this page gets its numbers.">
            <dl>
              <Row label="RPC">
                <span className="break-all">{rpcUrl}</span>
              </Row>
              <Row label="Jobs on the kernel">{data ? formatBigint(data.jobCounter) : "Loading"}</Row>
              <Row label="Indexer">
                {indexerUrl ? (
                  indexer.data ? (
                    <span>
                      {indexerUrl}; last indexed block {indexer.data.lastIndexedBlock ?? "unknown"} of {indexer.data.chainHead}; {indexer.data.jobs} jobs
                    </span>
                  ) : indexer.isError ? (
                    <span className="text-magenta">{indexerUrl} did not answer: {describeError(indexer.error)}</span>
                  ) : (
                    "Loading"
                  )
                ) : (
                  <span className="text-ash">Not configured; set NEXT_PUBLIC_INDEXER_URL to add the query surface</span>
                )}
              </Row>
            </dl>
          </PanelCard>
        </div>
      )}

      <PanelCard title="Design notes" description="Each one is the record of a decision.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {docs.map((doc) => (
            <li key={doc.href}>
              <a
                href={doc.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-4 rounded-2xl border border-fog px-5 py-4 text-body text-carbon transition-colors hover:bg-linen"
              >
                <span>{doc.label}</span>
                <span aria-hidden="true" className="text-ash">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      </PanelCard>
    </div>
  );
}
