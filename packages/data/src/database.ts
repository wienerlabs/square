export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Database {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function closeInsideTransaction(): Promise<never> {
  return Promise.reject(new Error("close() is not available on a transaction handle; close the Database that opened the transaction"));
}

export async function withSavepoint<T>(execute: (sql: string) => Promise<unknown>, depth: number, body: () => Promise<T>): Promise<T> {
  const name = `savepoint_${depth}`;
  await execute(`savepoint ${name}`);
  try {
    const result = await body();
    await execute(`release savepoint ${name}`);
    return result;
  } catch (error) {
    await execute(`rollback to savepoint ${name}`);
    throw error;
  }
}
