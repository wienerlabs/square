import { migrate, MIGRATIONS_DIR } from "../src/migrate.js";
import { pgliteDatabase } from "../src/pglite.js";
import type { Database } from "../src/database.js";
import type { Hex } from "../src/codec.js";

export async function openMigratedDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrate(db, MIGRATIONS_DIR, "up");
  return db;
}

export function address(seed: number): Hex {
  return `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;
}

export function hash32(seed: number): Hex {
  return `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
}
