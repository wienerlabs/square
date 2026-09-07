import type { Database } from "../database.js";

export async function increment(db: Database, bucket: string, windowStart: Date): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count)
     values ($1, $2, 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, windowStart],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("rate limit increment returned no row");
  return row.count;
}

export async function sweep(db: Database, windowMs: number): Promise<number> {
  const { rowCount } = await db.query("delete from rate_limits where window_start < now() - 2 * ($1::bigint * interval '1 millisecond')", [
    windowMs,
  ]);
  return rowCount;
}
