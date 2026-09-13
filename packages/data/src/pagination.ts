export interface ListPage {
  limit?: number | undefined;
  after?: bigint | undefined;
}

export interface PageSql {
  cursor: string;
  order: string;
  bound: string;
}

const CURSOR_COLUMN = "job_id";

export function pageSql(page: ListPage | undefined, params: unknown[], unpagedOrder: string): PageSql {
  if (page === undefined) return { cursor: "", order: unpagedOrder, bound: "" };
  let cursor = "";
  if (page.after !== undefined) {
    params.push(page.after.toString());
    cursor = ` and ${CURSOR_COLUMN} > $${params.length}`;
  }
  let bound = "";
  if (page.limit !== undefined) {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new RangeError("a page limit is a positive whole number");
    params.push(page.limit);
    bound = ` limit $${params.length}`;
  }
  return { cursor, order: CURSOR_COLUMN, bound };
}
