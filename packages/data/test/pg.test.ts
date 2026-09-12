import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { pgDatabaseFromPool } from "../src/pg.js";

const UNREACHABLE = "postgres://square:square@127.0.0.1:1/square_none";

describe("the pool behind pgDatabase", () => {
  it("hands an idle-client error to the caller instead of the process", async () => {
    const pool = new Pool({ connectionString: UNREACHABLE });
    const seen: string[] = [];
    pgDatabaseFromPool(pool, { onPoolError: (error) => seen.push(error.message) });

    const emit = (): boolean => pool.emit("error", new Error("server closed the connection unexpectedly"));

    expect(emit).not.toThrow();
    expect(seen).toEqual(["server closed the connection unexpectedly"]);
    await pool.end();
  });

  it("survives the same error with no handler supplied", async () => {
    const pool = new Pool({ connectionString: UNREACHABLE });
    pgDatabaseFromPool(pool);

    const emit = (): boolean => pool.emit("error", new Error("terminating connection due to administrator command"));

    expect(emit).not.toThrow();
    await pool.end();
  });

  it("wraps a thrown non-error so the handler always reads a message", async () => {
    const pool = new Pool({ connectionString: UNREACHABLE });
    const seen: string[] = [];
    pgDatabaseFromPool(pool, { onPoolError: (error) => seen.push(error.message) });

    pool.emit("error", "connection reset by peer" as unknown as Error);

    expect(seen).toEqual(["connection reset by peer"]);
    await pool.end();
  });
});
