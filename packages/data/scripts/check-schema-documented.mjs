import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const docPath = join(here, "..", "..", "..", "docs", "design", "data-layer.md");
const actionsPath = join(here, "..", "src", "repositories", "keeperActions.ts");

const RESERVED = new Set(["primary", "unique", "foreign", "constraint", "check", "exclude", "like", "partition"]);

function strip(body) {
  return body.replace(/--[^\n]*/g, "");
}

function schemaFromSql(sources) {
  const tables = new Map();
  const indexes = new Map();
  for (const { file, body } of sources) {
    const sql = strip(body);
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      const table = match[1].toLowerCase();
      const columns = tables.get(table) ?? new Set();
      for (const line of match[2].split("\n")) {
        const name = line.trim().match(/^([a-z_][a-z0-9_]*)\s/i);
        if (name && !RESERVED.has(name[1].toLowerCase())) columns.add(name[1].toLowerCase());
      }
      tables.set(table, columns);
    }
    for (const match of sql.matchAll(/alter\s+table\s+([a-z_][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      const table = match[1].toLowerCase();
      const columns = tables.get(table) ?? new Set();
      columns.add(match[2].toLowerCase());
      tables.set(table, columns);
    }
    for (const match of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      indexes.set(match[1].toLowerCase(), file);
    }
    for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      tables.delete(match[1].toLowerCase());
    }
    for (const match of sql.matchAll(/alter\s+table\s+([a-z_][a-z0-9_]*)\s+drop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      tables.get(match[1].toLowerCase())?.delete(match[2].toLowerCase());
    }
    for (const match of sql.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      indexes.delete(match[1].toLowerCase());
    }
  }
  return { tables, indexes };
}

const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".up.sql"))
  .sort()
  .map((file) => ({ file, body: readFileSync(join(migrationsDir, file), "utf8") }));

if (migrations.length === 0) {
  console.error("error: no migrations found in packages/data/migrations, refusing to report a pass");
  process.exit(1);
}

const doc = readFileSync(docPath, "utf8");
const code = schemaFromSql(migrations);
const written = schemaFromSql(
  [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((match, index) => ({
    file: `data-layer.md block ${index + 1}`,
    body: match[1],
  })),
);

const problems = [];

for (const [table, columns] of code.tables) {
  const documented = written.tables.get(table);
  if (!documented) {
    problems.push(`the migrations create table ${table} and data-layer.md has no block for it`);
    continue;
  }
  for (const column of columns) {
    if (!documented.has(column)) problems.push(`the migrations create ${table}.${column} and data-layer.md does not show it`);
  }
  for (const column of documented) {
    if (!columns.has(column)) problems.push(`data-layer.md shows ${table}.${column} and no migration creates it`);
  }
}
for (const table of written.tables.keys()) {
  if (!code.tables.has(table)) problems.push(`data-layer.md shows table ${table} and no migration creates it`);
}
for (const index of code.indexes.keys()) {
  if (!written.indexes.has(index)) problems.push(`the migrations create index ${index} and data-layer.md does not show it`);
}
for (const index of written.indexes.keys()) {
  if (!code.indexes.has(index)) problems.push(`data-layer.md shows index ${index} and no migration creates it`);
}

const union = readFileSync(actionsPath, "utf8").match(/export\s+type\s+KeeperAction\s*=([^;]+);/);
if (!union) {
  problems.push("keeperActions.ts no longer declares a KeeperAction union, so the action list cannot be checked");
} else {
  for (const match of union[1].matchAll(/"([^"]+)"/g)) {
    if (!new RegExp(`\\b${match[1]}\\b`).test(doc)) {
      problems.push(`KeeperAction carries ${match[1]} and data-layer.md never names it`);
    }
  }
}

if (problems.length > 0) {
  const annotate = process.env["GITHUB_ACTIONS"] ? "::error::" : "error: ";
  for (const problem of problems) console.error(`${annotate}${problem}`);
  console.error(
    `${annotate}${problems.length} disagreement(s) between packages/data/migrations and docs/design/data-layer.md. That document is what a reader plans a query against, so a hole in it is a wrong plan rather than a missing paragraph.`,
  );
  process.exit(1);
}

const columnCount = [...code.tables.values()].reduce((total, columns) => total + columns.size, 0);
console.log(
  `clean: ${code.tables.size} table(s), ${columnCount} column(s) and ${code.indexes.size} index(es) across ${migrations.length} migration(s) agree with docs/design/data-layer.md`,
);
