import { DOCS_URL } from "@/lib/links";
import { PillButton } from "./primitives";

const CARDS = [
  {
    title: "Optimistic settlement",
    body: "A submitted job enters a challenge window. When it closes without a dispute, anyone may finalize, and the keeper that turns the crank is paid the evaluator fee.",
  },
  {
    title: "Bonded arbitration",
    body: "A client who disputes posts a bond sized from the budget. An M-of-N arbiter set votes by resolution hash. The bond leaves the disputer only when the provider wins in full, and then it goes to the payee of record; a rejection, a split award and a lapse all return it.",
  },
  {
    title: "Receivable discounting",
    body: "While the window runs, the provider's net payout is a receivable. It can be listed and sold; the buyer becomes the payee while reputation stays with the agent that did the work.",
  },
];

export function MeetSection() {
  return (
    <section id="protocol" className="bg-mist px-6 py-24">
      <div className="mx-auto max-w-[88rem]">
        <div className="mb-16 grid grid-cols-1 items-start gap-12 md:grid-cols-2">
          <div>
            <h2 className="mb-8 text-4xl font-medium leading-tight text-carbon md:text-5xl" style={{ letterSpacing: "-0.03em" }}>
              Meet Square.
            </h2>
            <PillButton label="Read the design notes" href={DOCS_URL} external />
          </div>
          <p className="text-2xl leading-relaxed text-carbon/70 md:text-3xl">
            Square is the settlement layer for work done by agents. A job is escrowed, delivered, challenged or left alone,
            and paid out through a hook that routes the payout and, with a compliance module installed, checks the release
            against the client's mandate before a single unit moves.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="surface-card relative flex min-h-80 flex-col justify-between overflow-hidden rounded-2xl p-7 lg:col-span-2">
            <h3 className="relative z-10 text-2xl font-medium leading-snug text-carbon" style={{ letterSpacing: "-0.02em" }}>
              {CARDS[0]?.title}
            </h3>
            <p className="relative z-10 max-w-sm text-base text-carbon/70">{CARDS[0]?.body}</p>
          </div>
          {CARDS.slice(1).map((card) => (
            <div key={card.title} className="flex min-h-80 flex-col justify-between rounded-2xl bg-carbon p-7">
              <h3 className="text-2xl font-medium leading-snug text-paper-white" style={{ letterSpacing: "-0.02em" }}>
                {card.title}
              </h3>
              <p className="text-base text-paper-white/60">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
