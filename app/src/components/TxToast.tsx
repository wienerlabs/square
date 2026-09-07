"use client";

import { TxLink } from "./AddressLink";
import { truncate } from "@/lib/format";
import { useTx } from "@/lib/tx";

export function TxToast() {
  const { state, dismiss } = useTx();
  if (state.status === "idle") return null;

  const dot = state.status === "pending" ? "bg-amber" : state.status === "success" ? "bg-mint" : "bg-magenta";
  const title =
    state.status === "pending"
      ? `Sending ${state.label.toLowerCase()}`
      : state.status === "success"
        ? `${state.label} confirmed`
        : `${state.label} failed`;

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[600px] items-center gap-4 rounded-full border border-fog bg-paper-white py-2 pl-4 pr-2 shadow-subtle-3">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 text-caption">
          <p className="font-medium text-carbon">{title}</p>
          {state.status === "pending" ? (
            <p className="text-graphite">Confirm in your wallet, then wait for the receipt.</p>
          ) : null}
          {state.status === "success" ? (
            <p className="text-graphite">
              Receipt <TxLink hash={state.hash} />
            </p>
          ) : null}
          {state.status === "error" ? <p className="text-graphite">{truncate(state.message, 200)}</p> : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="h-8 shrink-0 rounded-full px-3 text-caption font-medium text-graphite transition-colors hover:bg-linen hover:text-carbon"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
