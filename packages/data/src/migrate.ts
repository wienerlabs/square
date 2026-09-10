import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export type MigrationDirection = "up" | "down";

export interface MigrationResult {
  applied: string[];
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+$/;
const DUPLICATE_OBJECT_CODES = new Set(["42P06", "42P07", "42701", "42710"]);
const UP_SUFFIX = ".up.sql";
const DOWN_SUFFIX = ".down.sql";

const ENSURE_SCHEMA_MIGRATIONS =
  "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())";
const LOCK_SCHEMA_MIGRATIONS = "lock table schema_migrations in access exclusive mode";
const IS_APPLIED = "select 1 from schema_migrations where name = $1";

export class MigrationConflictError extends Error {
  readonly migration: string;

  constructor(migration: string, cause: unknown) {
    super(
      `migration ${migration} stopped because an object it creates already exists: ${detailOf(cause)}. ` +
        `The migration runner is the only thing that may create these tables, so a table created by hand or by a package DDL snippet ` +
        `breaks the chain here and leaves every later migration unapplied. Either drop that object and run "square-data migrate up" again, ` +
        `or, when the existing object is already the one this migration would create, record the migration as applied with ` +
        `insert into schema_migrations (name) values ('${migration}'); and run "square-data migrate up" again.`,
      { cause },
    );
    this.name = "MigrationConflictError";
    this.migration = migration;
  }
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isDuplicateObject(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DUPLICATE_OBJECT_CODES.has(code);
}

export async function migrationStatus(db: Database, dir: string): Promise<MigrationStatus> {
  const available = await availableMigrations(dir);
  const applied = await appliedMigrations(db);
  const appliedSet = new Set(applied);
  return { applied, pending: available.filter((name) => !appliedSet.has(name)) };
}

export async function migrate(db: Database, dir: string, direction: MigrationDirection, steps?: number): Promise<MigrationResult> {
  if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) {
    throw new RangeError(`steps must be a positive integer, got ${String(steps)}`);
  }
  return direction === "up" ? migrateUp(db, dir, steps) : migrateDown(db, dir, steps ?? 1);
}

async function migrateUp(db: Database, dir: string, steps: number | undefined): Promise<MigrationResult> {
  const { pending } = await migrationStatus(db, dir);
  const selected = steps === undefined ? pending : pending.slice(0, steps);
  const scripts = await readScripts(dir, selected, UP_SUFFIX);
  const applied: string[] = [];
  for (const { name, sql } of scripts) {
    let wrote: boolean;
    try {
      wrote = await db.transaction(async (tx) => {
        await tx.query(LOCK_SCHEMA_MIGRATIONS);
        const { rows } = await tx.query(IS_APPLIED, [name]);
        if (rows.length > 0) return false;
        await tx.query(sql);
        await tx.query("insert into schema_migrations (name) values ($1)", [name]);
        return true;
      });
    } catch (error) {
      if (isDuplicateObject(error)) throw new MigrationConflictError(name, error);
      throw error;
    }
    if (wrote) applied.push(name);
  }
  return { applied };
}

async function migrateDown(db: Database, dir: string, steps: number): Promise<MigrationResult> {
  const applied = await appliedMigrations(db);
  const selected = applied.slice(-steps).reverse();
  const scripts = await readScripts(dir, selected, DOWN_SUFFIX);
  const reverted: string[] = [];
  for (const { name, sql } of scripts) {
    await db.transaction(async (tx) => {
      await tx.query(LOCK_SCHEMA_MIGRATIONS);
      await tx.query(sql);
      await tx.query("delete from schema_migrations where name = $1", [name]);
    });
    reverted.push(name);
  }
  return { applied: reverted };
}

async function availableMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const names = entries
    .filter((entry) => entry.endsWith(UP_SUFFIX))
    .map((entry) => entry.slice(0, -UP_SUFFIX.length))
    .sort();
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) {
      throw new Error(`migration ${name}${UP_SUFFIX} is not named NNNN_name${UP_SUFFIX}`);
    }
    if (!entries.includes(`${name}${DOWN_SUFFIX}`)) {
      throw new Error(`migration ${name} has no ${DOWN_SUFFIX} file; every migration must be reversible`);
    }
  }
  return names;
}

async function appliedMigrations(db: Database): Promise<string[]> {
  await db.query(ENSURE_SCHEMA_MIGRATIONS);
  const { rows } = await db.query<{ name: string }>("select name from schema_migrations order by name");
  return rows.map((row) => row.name);
}

async function readScripts(dir: string, names: string[], suffix: string): Promise<Array<{ name: string; sql: string }>> {
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, `${name}${suffix}`), "utf8") })));
}
