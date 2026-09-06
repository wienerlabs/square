import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rateLimits from "../src/repositories/rateLimits.js";
import { migrate, MIGRATIONS_DIR } from "../src/migrate.js";
import { pgliteDatabase } from "../src/pglite.js";
import { openMigratedDatabase } from "./helpers.js";

const WINDOW_MS = 60_000;

function windowStart(at: number): Date {
  return new Date(Math.floor(at / WINDOW_MS) * WINDOW_MS);
}

describe("rateLimits.increment", () => {
  it("counts within a window and starts a new window at one", async () => {
    const db = await openMigratedDatabase();
    try {
      const first = windowStart(Date.now());
      expect(await rateLimits.increment(db, "ip:1.2.3.4", first)).toBe(1);
      expect(await rateLimits.increment(db, "ip:1.2.3.4", first)).toBe(2);
      expect(await rateLimits.increment(db, "ip:1.2.3.4", first)).toBe(3);

      const next = new Date(first.getTime() + WINDOW_MS);
      expect(await rateLimits.increment(db, "ip:1.2.3.4", next)).toBe(1);
      expect(await rateLimits.increment(db, "actor:0xabc", first)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("survives a restart: the same PGlite data directory reopened still holds the counts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "square-data-rate-limits-"));
    try {
      const window = windowStart(Date.now());
      const before = await pgliteDatabase({ dataDir });
      await migrate(before, MIGRATIONS_DIR, "up");
      expect(await rateLimits.increment(before, "ip:9.9.9.9", window)).toBe(1);
      expect(await rateLimits.increment(before, "ip:9.9.9.9", window)).toBe(2);
      expect(await rateLimits.increment(before, "ip:9.9.9.9", window)).toBe(3);
      await before.close();

      const after = await pgliteDatabase({ dataDir });
      try {
        expect(await rateLimits.increment(after, "ip:9.9.9.9", window)).toBe(4);
      } finally {
        await after.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("sweeps windows older than two window lengths", async () => {
    const db = await openMigratedDatabase();
    try {
      const now = Date.now();
      await rateLimits.increment(db, "ip:1.1.1.1", windowStart(now - 10 * WINDOW_MS));
      await rateLimits.increment(db, "ip:1.1.1.1", windowStart(now - WINDOW_MS));
      await rateLimits.increment(db, "ip:1.1.1.1", windowStart(now));
      expect(await rateLimits.sweep(db, WINDOW_MS)).toBe(1);
      const { rows } = await db.query<{ n: string }>("select count(*) as n from rate_limits");
      expect(rows[0]?.n).toBe("2");
    } finally {
      await db.close();
    }
  });
});
