import type { ReactNode } from "react";

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div>
        <p className="text-body font-medium text-carbon">{title}</p>
        {hint ? <p className="mt-1 max-w-md text-caption text-graphite">{hint}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
