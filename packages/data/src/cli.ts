#!/usr/bin/env node
import { MIGRATIONS_DIR, migrate, migrationStatus, type MigrationDirection } from "./migrate.js";
import { pgDatabase } from "./pg.js";

const USAGE = [
  "usage: square-data migrate up",
  "       square-data migrate down [steps]",
  "       square-data migrate status",
  "",
  "The connection string is read from DATABASE_URL.",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const [command, action, stepsArg] = argv;
  if (command !== "migrate" || (action !== "up" && action !== "down" && action !== "status")) {
    console.error(USAGE);
    return 2;
  }
  const steps = parseSteps(action, stepsArg);
  if (steps instanceof Error) {
    console.error(steps.message);
    return 2;
  }
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const db = pgDatabase(connectionString, { max: 1 });
  try {
    if (action === "status") {
      printStatus(await migrationStatus(db, MIGRATIONS_DIR));
    } else {
      printApplied(action, (await migrate(db, MIGRATIONS_DIR, action, steps)).applied);
    }
    return 0;
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
