#!/usr/bin/env node
import { MIGRATIONS_DIR, migrate, migrationStatus, type MigrationDirection } from "./migrate.js";
import { pgDatabase } from "./pg.js";
import { DEFAULT_RATE_LIMIT_WINDOW_MS, sweepAll } from "./retention.js";
import type { Database } from "./database.js";

const USAGE = [
  "usage: square-data migrate up",
  "       square-data migrate down [steps]",
  "       square-data migrate status",
  "       square-data sweep [rateLimitWindowMs]",
  "",
  "The connection string is read from DATABASE_URL.",
  `sweep runs every retention sweep once. rateLimitWindowMs defaults to ${DEFAULT_RATE_LIMIT_WINDOW_MS}`,
  "and must match the windowMs the rate limiter is configured with.",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "migrate") return runMigrate(rest);
  if (command === "sweep") return runSweep(rest);
  console.error(USAGE);
  return 2;
}

async function runMigrate(argv: string[]): Promise<number> {
  const [action, stepsArg] = argv;
  if (action !== "up" && action !== "down" && action !== "status") {
    console.error(USAGE);
    return 2;
  }
  const steps = parseSteps(action, stepsArg);
  if (steps instanceof Error) {
    console.error(steps.message);
    return 2;
  }
  return withDatabase(async (db) => {
    if (action === "status") {
      printStatus(await migrationStatus(db, MIGRATIONS_DIR));
    } else {
      printApplied(action, (await migrate(db, MIGRATIONS_DIR, action, steps)).applied);
    }
    return 0;
  });
}

async function runSweep(argv: string[]): Promise<number> {
  const rateLimitWindowMs = parseRateLimitWindow(argv[0]);
  if (rateLimitWindowMs instanceof Error) {
    console.error(rateLimitWindowMs.message);
    return 2;
  }
  return withDatabase(async (db) => {
    const { removed, failures } = await sweepAll(db, { rateLimitWindowMs });
    for (const [table, rows] of Object.entries(removed)) console.log(`swept ${rows} from ${table}`);
    for (const failure of failures) console.error(`sweep failed for ${failure.table}: ${failure.message}`);
    return failures.length === 0 ? 0 : 1;
  });
}

async function withDatabase(run: (db: Database) => Promise<number>): Promise<number> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const db = pgDatabase(connectionString, {
    max: 1,
    onPoolError: (error) => console.error(`pool connection lost: ${error.message}`),
  });
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

function parseSteps(action: MigrationDirection | "status", stepsArg: string | undefined): number | undefined | Error {
  if (stepsArg === undefined) return undefined;
  if (action !== "down") return new Error(`${action} does not take a step count`);
  const steps = Number(stepsArg);
  return Number.isInteger(steps) && steps > 0 ? steps : new Error(`steps must be a positive integer, got ${stepsArg}`);
}

function parseRateLimitWindow(windowArg: string | undefined): number | Error {
  if (windowArg === undefined) return DEFAULT_RATE_LIMIT_WINDOW_MS;
  const windowMs = Number(windowArg);
  return Number.isInteger(windowMs) && windowMs > 0
    ? windowMs
    : new Error(`rateLimitWindowMs must be a positive integer, got ${windowArg}`);
}

function printStatus(status: { applied: string[]; pending: string[] }): void {
  console.log(`applied (${status.applied.length})`);
  for (const name of status.applied) console.log(`  ${name}`);
  console.log(`pending (${status.pending.length})`);
  for (const name of status.pending) console.log(`  ${name}`);
}

function printApplied(action: MigrationDirection, names: string[]): void {
  const verb = action === "up" ? "applied" : "reverted";
  if (names.length === 0) {
    console.log(`nothing to ${action === "up" ? "apply" : "revert"}`);
    return;
  }
  for (const name of names) console.log(`${verb} ${name}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
