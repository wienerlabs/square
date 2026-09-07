import { describe, it, expect } from "vitest";
import { migrate, migrationStatus, MIGRATIONS_DIR } from "../src/migrate.js";
import { pgliteDatabase } from "../src/pglite.js";
import type { Database } from "../src/database.js";

const ALL = ["0001_indexer", "0002_hardening", "0003_x402", "0004_hosted_agents", "0005_keeper"];

async function tableNames(db: Database): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  return rows.map((row) => row.table_name);
}

async function schemaSnapshot(db: Database): Promise<unknown> {
  const columns = await db.query(
    `select table_name, column_name, data_type, is_nullable, column_default, numeric_precision, numeric_scale
     from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
  );
  const indexes = await db.query("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname");
  return { tables: await tableNames(db), columns: columns.rows, indexes: indexes.rows };
}

describe("migrations", () => {
  it("applies all five in order, reverts the last one, and re-applies it", async () => {
    const db = await pgliteDatabase();
    try {
      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual(ALL);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL, pending: [] });
      expect(await tableNames(db)).toEqual([
        "arbiter_sets",
        "claim_listings",
        "disputes",
        "hosted_agents",
        "idempotency_keys",
        "indexer_checkpoints",
        "job_events",
        "jobs",
        "keeper_actions",
        "ledger_balances",
        "rate_limits",
        "schema_migrations",
        "x402_payments",
      ]);

      expect((await migrate(db, MIGRATIONS_DIR, "down")).applied).toEqual(["0005_keeper"]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL.slice(0, 4), pending: ["0005_keeper"] });
      expect(await tableNames(db)).not.toContain("keeper_actions");

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual(["0005_keeper"]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL, pending: [] });
      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("up, down five steps, up leaves the schema identical", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up");
      const first = await schemaSnapshot(db);

      expect((await migrate(db, MIGRATIONS_DIR, "down", 5)).applied).toEqual([...ALL].reverse());
      expect(await tableNames(db)).toEqual(["schema_migrations"]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: [], pending: ALL });

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual(ALL);
      expect(await schemaSnapshot(db)).toEqual(first);
    } finally {
      await db.close();
    }
  });

  it("records applied_at in schema_migrations", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up", 1);
      const { rows } = await db.query<{ name: string; applied_at: Date }>("select name, applied_at from schema_migrations");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("0001_indexer");
      expect(rows[0]?.applied_at).toBeInstanceOf(Date);
    } finally {
      await db.close();
    }
  });
});
