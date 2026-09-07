import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: ReactNode;
  caption?: string;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-fog bg-paper-white">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-body">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-fog">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`border-r border-fog px-5 py-3 text-caption font-medium text-graphite last:border-r-0 ${column.align === "right" ? "text-right" : "text-left"}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-5">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)} className="border-b border-fog transition-colors last:border-b-0 hover:bg-linen">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`border-r border-fog px-5 py-3.5 align-middle last:border-r-0 ${column.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
