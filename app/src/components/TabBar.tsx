"use client";

export interface Tab {
  id: string;
  label: string;
  count?: number;
}

export function TabBar({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-6 overflow-x-auto border-b border-fog">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`relative -mb-px flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-1 text-body font-medium transition-colors ${selected ? "border-lavender text-carbon" : "border-transparent text-graphite hover:text-carbon"}`}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="rounded-full bg-mist px-2 py-0.5 text-caption tabular-nums text-graphite">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
