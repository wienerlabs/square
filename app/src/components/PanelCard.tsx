import type { ReactNode } from "react";

export function PanelCard({
  title,
  description,
  actions,
  elevated = false,
  className = "",
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  elevated?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-2xl border border-fog bg-paper-white p-8 ${elevated ? "shadow-subtle-3" : ""} ${className}`}>
      {title || actions ? (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            {title ? <h2 className="text-subheading font-medium text-carbon">{title}</h2> : null}
            {description ? <p className="mt-1 text-caption text-graphite">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
