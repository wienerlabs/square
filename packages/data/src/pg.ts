import { Pool, type PoolClient } from "pg";
import { closeInsideTransaction, withSavepoint, type Database, type QueryResult } from "./database.js";

export interface PgDatabaseOptions {
  max?: number;
  onPoolError?: (error: Error) => void;
}

interface PgExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

interface PgResultShape<T> {
  rows: T[];
  rowCount: number | null;
}

export function pgDatabase(connectionString: string, options: PgDatabaseOptions = {}): Database {
  return pgDatabaseFromPool(new Pool({ connectionString, max: options.max }), options);
}

export function pgDatabaseFromPool(pool: Pool, options: PgDatabaseOptions = {}): Database {
  pool.on("error", (error: unknown) => {
    options.onPoolError?.(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    query: (text, params) => runQuery(pool, text, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(transactionDatabase(client, 0));
        await client.query("commit");
        client.release();
        return result;
      } catch (error) {
        await rollbackAndRelease(client);
        throw error;
      }
    },
    close: () => pool.end(),
  };
}

function transactionDatabase(client: PoolClient, depth: number): Database {
  return {
    query: (text, params) => runQuery(client, text, params),
    transaction: (fn) => withSavepoint((sql) => client.query(sql), depth, () => fn(transactionDatabase(client, depth + 1))),
    close: closeInsideTransaction,
  };
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try {
    await client.query("rollback");
    client.release();
  } catch (rollbackError) {
    client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
  }
}

async function runQuery<T>(executor: PgExecutor, text: string, params: unknown[] | undefined): Promise<QueryResult<T>> {
  const outcome = params === undefined || params.length === 0 ? await executor.query(text) : await executor.query(text, params);
  const last = (Array.isArray(outcome) ? outcome[outcome.length - 1] : outcome) as PgResultShape<T> | undefined;
  return last === undefined ? { rows: [], rowCount: 0 } : { rows: last.rows, rowCount: last.rowCount ?? 0 };
}
