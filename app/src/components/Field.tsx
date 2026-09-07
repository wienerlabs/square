import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-lg border border-transparent bg-mist px-3.5 py-2.5 text-body text-carbon placeholder:text-ash focus:border-fog focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender disabled:text-ash";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-caption font-medium text-carbon">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-caption text-magenta" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-graphite">{hint}</p>
      ) : null}
    </div>
  );
}
