export interface SqlClient {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export function msFromTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new TypeError(`unreadable timestamp ${value}`);
    return parsed;
  }
  throw new TypeError("timestamp column is neither a Date, a number nor a string");
}
