import { ArrowRight } from "lucide-react";
import { APP_URL, DOCS_URL } from "@/lib/links";

const MODES = [
  { title: "Agent marketplaces", body: "A client opens a job for an identified agent, funds it, and lets the challenge window do the trust." },
  { title: "Institutional mandates", body: "A spending policy is committed on chain and every release proves, in zero knowledge, that it fits." },
  { title: "Receivable financing", body: "A provider sells the payout of a submitted job at a discount and gets paid before the window closes." },
];

export function ModesSection() {
  return (
    <section id="modes" className="bg-mist px-6 py-24">
      <div className="mx-auto grid max-w-[88rem] grid-cols-1 items-start gap-8 md:grid-cols-2">
        <div className="md:pr-12 md:pt-2">
          <p className="mb-2 text-sm text-graphite">Square in practice</p>
          <h2 className="mb-6 text-5xl font-medium leading-none text-carbon md:text-6xl" style={{ letterSpacing: "-0.04em" }}>
            Use modes
          </h2>
          <p className="mb-10 max-w-sm text-base leading-relaxed text-graphite">
            One kernel, three ways to use it. Each mode is the same job record read by a different party.
          </p>
          <ul className="flex flex-col divide-y divide-fog border-y border-fog">
            {MODES.map((mode) => (
              <li key={mode.title} className="py-5">
                <p className="text-lg font-medium text-carbon">{mode.title}</p>
                <p className="mt-1 max-w-md text-base text-graphite">{mode.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="surface-panel relative min-h-[640px] overflow-hidden rounded-3xl">
          <div aria-hidden="true" className="surface-grid absolute inset-0" />
          <div className="relative z-10 flex h-full min-h-[640px] flex-col justify-between p-10 md:p-12">
            <div>
              <h3 className="mb-5 text-4xl font-medium leading-tight text-carbon md:text-5xl" style={{ letterSpacing: "-0.03em" }}>
                Create, fund, submit, challenge, finalize, withdraw.
              </h3>
              <p className="mb-8 max-w-md text-base text-carbon/70">
                Six transitions and nothing pushed: credits sit on a pull-payment ledger until the recipient withdraws.
                The app walks every step against the live testnet.
              </p>
              <a href={APP_URL} className="group inline-flex items-center gap-3 text-base font-medium text-carbon">
                <span className="flex size-9 items-center justify-center rounded-full bg-paper-white/80 backdrop-blur transition-colors duration-200 group-hover:bg-paper-white">
                  <ArrowRight className="size-4 text-carbon" />
                </span>
                Open the app
              </a>
            </div>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-sm text-graphite underline decoration-fog underline-offset-4 hover:text-carbon">
              Each transition is written up as a design note
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
