import type { ReactNode } from "react";

export type StepState = "todo" | "done" | "error";

export function Step({
  number,
  title,
  description,
  state,
  last = false,
  aside,
  children,
}: {
  number: number;
  title: string;
  description?: ReactNode;
  state: StepState;
  last?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const badge =
    state === "done" ? "bg-carbon text-paper-white" : state === "error" ? "bg-magenta/10 text-magenta" : "bg-mist text-graphite";
  return (
    <section className="flex gap-5">
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-caption font-medium tabular-nums ${badge}`}
        >
          {state === "done" ? "✓" : number}
        </span>
        {!last ? <span aria-hidden="true" className="mt-2 w-px flex-1 bg-fog" /> : null}
      </div>
      <div className={`flex min-w-0 flex-1 flex-col gap-5 ${last ? "" : "pb-10"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-subheading font-medium text-carbon">
              <span className="sr-only">Step {number}: </span>
              {title}
            </h3>
            {description ? <p className="mt-1 text-caption text-graphite">{description}</p> : null}
          </div>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}
