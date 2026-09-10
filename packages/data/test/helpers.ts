import { migrate, MIGRATIONS_DIR } from "../src/migrate.js";
import { pgliteDatabase } from "../src/pglite.js";
import type { Database, QueryResult } from "../src/database.js";
import type { Hex } from "../src/codec.js";

export async function openMigratedDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

export function databaseWithClockAhead(db: Database, aheadMs: number): Database {
  const realNow = Date.now;
  const skewed = async <T>(body: () => Promise<T>): Promise<T> => {
    Date.now = () => realNow.call(Date) + aheadMs;
    try {
      return await body();
    } finally {
      Date.now = realNow;
    }
  };
  return {
    query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      return skewed(() => db.query<T>(text, params));
    },
    transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      return skewed(() => db.transaction(fn));
    },
    close(): Promise<void> {
      return db.close();
    },
  };
}

export function address(seed: number): Hex {
  return `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;
}

export function hash32(seed: number): Hex {
  return `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
}
