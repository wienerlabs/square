import { PGlite, types, type Results, type Transaction } from "@electric-sql/pglite";
import { closeInsideTransaction, withSavepoint, type Database, type QueryResult } from "./database.js";

export interface PgliteDatabaseOptions {
  dataDir?: string;
}

type PgliteExecutor = Pick<Transaction, "query" | "exec">;

const int8AsDecimalString = { [types.INT8]: (value: string) => value };

export async function pgliteDatabase(options: PgliteDatabaseOptions = {}): Promise<Database> {
  const pglite = await PGlite.create({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    parsers: int8AsDecimalString,
  });
  return {
    query: (text, params) => runQuery(pglite, text, params),
    transaction: (fn) => pglite.transaction((tx) => fn(transactionDatabase(tx, 0))),
    close: () => pglite.close(),
  };
}

function transactionDatabase(executor: PgliteExecutor, depth: number): Database {
  return {
    query: (text, params) => runQuery(executor, text, params),
    transaction: (fn) => withSavepoint((sql) => executor.exec(sql), depth, () => fn(transactionDatabase(executor, depth + 1))),
    close: closeInsideTransaction,
  };
}

async function runQuery<T>(executor: PgliteExecutor, text: string, params: unknown[] | undefined): Promise<QueryResult<T>> {
  if (params === undefined || params.length === 0) {
    const results = await executor.exec(text);
    const last = results[results.length - 1];
    return last === undefined ? { rows: [], rowCount: 0 } : toQueryResult(last as Results<T>);
  }
  return toQueryResult(await executor.query<T>(text, params));
}

function toQueryResult<T>(result: Results<T>): QueryResult<T> {
  return { rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0) };
}
