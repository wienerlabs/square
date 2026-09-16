import { describe, it, expect } from "vitest";
import { migrate, migrationStatus, MigrationConflictError, MIGRATIONS_DIR } from "../src/migrate.js";
import { pgliteDatabase } from "../src/pglite.js";
import type { Database } from "../src/database.js";

const ALL = [
  "0001_indexer",
  "0002_hardening",
  "0003_x402",
  "0004_hosted_agents",
  "0005_keeper",
  "0006_x402_reason",
  "0007_refund_reason_and_expiry_sweep",
  "0008_keeper_give_up",
  "0009_x402_last_checked",
  "0010_quarantined_events",
  "0011_x402_valid_before_repair",
  "0012_keeper_job_state",
  "0013_keeper_unprofitable_journal",
  "0014_keeper_hold",
];

const LAST = "0014_keeper_hold";
const UNPROFITABLE_JOURNAL = "0013_keeper_unprofitable_journal";
const JOB_STATE = "0012_keeper_job_state";
const REPAIR = "0011_x402_valid_before_repair";

async function tableNames(db: Database): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  return rows.map((row) => row.table_name);
}

async function indexNames(db: Database, table: string): Promise<string[]> {
  const { rows } = await db.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname",
    [table],
  );
  return rows.map((row) => row.indexname);
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
    [table],
  );
  return rows.map((row) => row.column_name);
}

function racedAtFirstTransaction(db: Database, race: () => Promise<unknown>): Database {
  let raced = false;
  return {
    ...db,
    async transaction(fn) {
      if (!raced) {
        raced = true;
        await race();
      }
      return db.transaction(fn);
    },
  };
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
  it("applies all fourteen in order, reverts the last one, and re-applies it", async () => {
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
        "keeper_job_state",
        "ledger_balances",
        "quarantined_events",
        "rate_limits",
        "schema_migrations",
        "x402_payments",
      ]);

      expect(await tableNames(db)).toContain("quarantined_events");
      expect(await indexNames(db, "x402_payments")).toContain("x402_payments_expiry");

      expect((await migrate(db, MIGRATIONS_DIR, "down")).applied).toEqual([LAST]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL.slice(0, 13), pending: [LAST] });
      expect(await columnNames(db, "keeper_job_state")).not.toContain("held_reason");
      expect(await indexNames(db, "keeper_job_state")).not.toContain("keeper_job_state_held");

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual([LAST]);
      expect(await tableNames(db)).toContain("keeper_job_state");
      expect(await columnNames(db, "keeper_job_state")).toContain("unprofitable_journaled_at");
      expect(await columnNames(db, "keeper_job_state")).toEqual(expect.arrayContaining(["held_reason", "held_since"]));
      expect(await indexNames(db, "keeper_job_state")).toContain("keeper_job_state_held");
      expect(await columnNames(db, "x402_payments")).toContain("last_checked_at");
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL, pending: [] });
      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("up, down fourteen steps, up leaves the schema identical", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up");
      const first = await schemaSnapshot(db);

      expect((await migrate(db, MIGRATIONS_DIR, "down", 14)).applied).toEqual([...ALL].reverse());
      expect(await tableNames(db)).toEqual(["schema_migrations"]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: [], pending: ALL });

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual(ALL);
      expect(await schemaSnapshot(db)).toEqual(first);
    } finally {
      await db.close();
    }
  });

  it("names the fix when a table it creates already exists, instead of stalling the chain", async () => {
    const db = await pgliteDatabase();
    try {
      await db.query(`create table x402_payments (
        chain_id bigint not null, asset bytea not null, payer bytea not null, nonce bytea not null,
        amount numeric not null, pay_to bytea not null, resource text not null, tx_hash bytea,
        status smallint not null, valid_before bigint not null, created_at timestamptz not null default now(),
        primary key (chain_id, asset, payer, nonce))`);

      const failure = await migrate(db, MIGRATIONS_DIR, "up").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MigrationConflictError);
      const conflict = failure as MigrationConflictError;
      expect(conflict.migration).toBe("0003_x402");
      expect(conflict.message).toContain('relation "x402_payments" already exists');
      expect(conflict.message).toContain("insert into schema_migrations (name) values ('0003_x402')");
      expect(conflict.message).toContain("square-data migrate up");

      const status = await migrationStatus(db, MIGRATIONS_DIR);
      expect(status.applied).toEqual(["0001_indexer", "0002_hardening"]);
      expect(status.pending).toEqual([
        "0003_x402",
        "0004_hosted_agents",
        "0005_keeper",
        "0006_x402_reason",
        "0007_refund_reason_and_expiry_sweep",
        "0008_keeper_give_up",
        "0009_x402_last_checked",
        "0010_quarantined_events",
        REPAIR,
        JOB_STATE,
        UNPROFITABLE_JOURNAL,
        LAST,
      ]);

      await db.query("insert into schema_migrations (name) values ('0003_x402')");
      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual([
        "0004_hosted_agents",
        "0005_keeper",
        "0006_x402_reason",
        "0007_refund_reason_and_expiry_sweep",
        "0008_keeper_give_up",
        "0009_x402_last_checked",
        "0010_quarantined_events",
        REPAIR,
        JOB_STATE,
        UNPROFITABLE_JOURNAL,
        LAST,
      ]);
      expect(await tableNames(db)).toContain("keeper_actions");
    } finally {
      await db.close();
    }
  });

  it("lets two runners race one PGlite database: both return, and every migration is applied exactly once", async () => {
    const db = await pgliteDatabase();
    try {
      const [first, second] = await Promise.all([migrate(db, MIGRATIONS_DIR, "up"), migrate(db, MIGRATIONS_DIR, "up")]);

      expect([...first.applied, ...second.applied].sort()).toEqual(ALL);
      expect(first.applied.filter((name) => second.applied.includes(name))).toEqual([]);

      const { rows } = await db.query<{ name: string; n: number }>(
        "select name, count(*)::int as n from schema_migrations group by name order by name",
      );
      expect(rows).toEqual(ALL.map((name) => ({ name, n: 1 })));
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: ALL, pending: [] });
      expect(await tableNames(db)).toContain("x402_payments");
    } finally {
      await db.close();
    }
  });

  it("skips, rather than conflicts, when another runner records a migration between the pending scan and the lock", async () => {
    const db = await pgliteDatabase();
    try {
      const loser = racedAtFirstTransaction(db, () => migrate(db, MIGRATIONS_DIR, "up", 1));

      expect((await migrate(loser, MIGRATIONS_DIR, "up", 1)).applied).toEqual([]);
      expect(await migrationStatus(db, MIGRATIONS_DIR)).toEqual({ applied: [ALL[0]], pending: ALL.slice(1) });
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from schema_migrations");
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await db.close();
    }
  });

  it("removes a valid_before no retention sweep could ever reach, and keeps the rows that are reachable", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up", 9);
      const insert = `insert into x402_payments (chain_id, asset, payer, nonce, amount, pay_to, resource, status, valid_before)
         values (5042002, $1, $2, $3, 1, $4, '/v1/resolve', 1, $5)`;
      const bytes = (seed: number) => Uint8Array.from([seed]);
      await db.query(insert, [bytes(0xa0), bytes(0xb1), bytes(0x01), bytes(0xc2), (2n ** 62n).toString()]);
      await db.query(insert, [bytes(0xa0), bytes(0xb1), bytes(0x02), bytes(0xc2), "9224315424000"]);
      await db.query(insert, [bytes(0xa0), bytes(0xb1), bytes(0x03), bytes(0xc2), "9224315423999"]);
      await db.query(insert, [bytes(0xa0), bytes(0xb1), bytes(0x04), bytes(0xc2), "1800000000"]);

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual(["0010_quarantined_events", REPAIR, JOB_STATE, UNPROFITABLE_JOURNAL, LAST]);

      const { rows } = await db.query<{ valid_before: string }>(
        "select valid_before from x402_payments order by valid_before",
      );
      expect(rows.map((row) => row.valid_before)).toEqual(["1800000000", "9224315423999"]);
      expect(await indexNames(db, "x402_payments")).toContain("x402_payments_expiry");
    } finally {
      await db.close();
    }
  });

  it("carries the skipped rows a keeper already wrote into the unprofitable mark, so no restart writes them again", async () => {
    const db = await pgliteDatabase();
    try {
      await migrate(db, MIGRATIONS_DIR, "up", 12);
      const insert = "insert into keeper_actions (chain_id, job_id, action, reason) values ($1, $2, $3, $4)";
      await db.query(insert, [31337, "1", "skipped", "unprofitable"]);
      await db.query(insert, [31337, "1", "skipped", "unprofitable"]);
      await db.query(insert, [31337, "2", "finalize", null]);

      expect((await migrate(db, MIGRATIONS_DIR, "up")).applied).toEqual([UNPROFITABLE_JOURNAL, LAST]);

      const { rows } = await db.query<{ job_id: string; unprofitable_journaled_at: Date | null }>(
        "select job_id, unprofitable_journaled_at from keeper_job_state order by job_id",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.job_id).toBe("1");
      expect(rows[0]?.unprofitable_journaled_at).toBeInstanceOf(Date);
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
