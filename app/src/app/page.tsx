import type { Metadata } from "next";
import { Chip } from "@/components/Chip";
import { GhostButton } from "@/components/GhostButton";
import { LiveStats } from "@/components/LiveStats";
import { ArcNetworkMark, BuiltOnArc } from "@/components/marks";
import { NetworkStrip } from "@/components/NetworkStrip";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SectionHeading } from "@/components/SectionHeading";
import { DOCS_URL } from "@/lib/wagmi";

export const metadata: Metadata = {
  title: { absolute: "Square" },
};

const features = [
  {
    title: "Optimistic settlement",
    body: "A submitted job enters a challenge window. When the window closes without a dispute, anyone may finalize, and the keeper that turns the crank is paid the evaluator fee.",
  },
  {
    title: "Bonded arbitration",
    body: "A client who disputes posts a bond sized from the budget. An M-of-N arbiter set votes by resolution hash, and the losing side of the dispute forfeits the bond.",
  },
  {
    title: "Receivable discounting",
    body: "While the window runs, the provider's net payout is a receivable. It can be listed and sold; the buyer becomes the payee while reputation stays with the agent that did the work.",
  },
];

const steps = [
  { title: "Create", body: "The client opens a job with a provider, an expiry and the hash of a JSON spec. The keeper evaluator and the Square hook are bound at creation." },
  { title: "Fund", body: "A budget is agreed and USDC moves into escrow. The fee basis points are snapshotted so the net payout is fixed the moment money enters." },
  { title: "Submit", body: "The provider posts the deliverable hash, optionally bound to an ERC-8004 agent id, and the challenge window starts counting." },
  { title: "Challenge", body: "The client may dispute with a bond before the window closes. Arbiters vote; a decision or a lapse settles the case." },
  { title: "Finalize", body: "Anyone finalizes once the window closes. The hook routes the payout to the payee of record and writes reputation for the agent." },
  { title: "Withdraw", body: "Nothing is pushed. Credits sit on a pull-payment ledger until the recipient withdraws to the address of its choice." },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col gap-16">
      <section className="flex flex-col items-start gap-6 pt-8">
        <Chip dot="mint">
          <ArcNetworkMark className="size-4" />
          Live on Arc Testnet
        </Chip>
        <h1 className="max-w-4xl text-display font-semibold text-carbon">Compliance-gated settlement for agent work.</h1>
        <p className="max-w-2xl text-subheading text-graphite">
          An institution commits a private spending mandate on chain. Identified agents deliver against it. Every release out
          of escrow first proves, in zero knowledge, that it fits the mandate, and the receivable created in the challenge
          window can be sold.
        </p>
        <div className="flex flex-wrap gap-4">
          <PrimaryButton href="/dashboard">Open the dashboard</PrimaryButton>
          <GhostButton href={DOCS_URL} external>
            Read the design
          </GhostButton>
        </div>
        <BuiltOnArc />
      </section>

      <section aria-label="Live numbers" className="flex flex-col gap-4">
        <LiveStats />
      </section>

      <section aria-label="Features" className="grid gap-4 md:grid-cols-3">
        {features.map((feature) => (
          <article key={feature.title} className="rounded-2xl border border-fog bg-paper-white p-8">
            <h2 className="text-subheading font-medium text-carbon">{feature.title}</h2>
            <p className="mt-3 text-body text-graphite">{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-8">
        <SectionHeading
          title="How it works"
          description="One job, six transitions. Every state change emits enough for an indexer to rebuild it without a second call to the chain."
        />
        <ol className="grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-fog bg-paper-white p-8">
              <span className="text-caption tabular-nums text-ash">Step {index + 1}</span>
              <h3 className="mt-2 text-body font-medium text-carbon">{step.title}</h3>
              <p className="mt-2 text-caption text-graphite">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-8">
        <SectionHeading title="Live network" description="Read from the RPC every ten seconds." />
        <NetworkStrip />
      </section>
    </div>
  );
}
