import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const serviceDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node scripts/check-env-documented.mjs <service directory>");
  process.exit(2);
}

const srcDir = join(serviceDir, "src");
const readmePath = join(serviceDir, "README.md");
const service = basename(serviceDir);

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const files = sources(srcDir);
if (files.length === 0) {
  console.error(`error: no TypeScript sources under ${srcDir}, refusing to report a pass`);
  process.exit(1);
}

const bodies = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));
const all = [...bodies.values()].join("\n");

const helpers = new Set();
for (const match of all.matchAll(/function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*name\s*:\s*string[\s\S]{0,400}?process\.env/g)) {
  helpers.add(match[1]);
}

const read = new Map();
const note = (name, path) => {
  if (!read.has(name)) read.set(name, new Set());
  read.get(name).add(path.slice(serviceDir.length + 1));
};

for (const [path, body] of bodies) {
  for (const match of body.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) note(match[1], path);
  for (const match of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) note(match[1], path);
  for (const helper of helpers) {
    for (const match of body.matchAll(new RegExp(`\\b${helper}\\(\\s*"([A-Z][A-Z0-9_]*)"`, "g"))) note(match[1], path);
  }
}

if (read.size === 0) {
  console.error(`error: no environment variables found in ${srcDir}, refusing to report a pass`);
  process.exit(1);
}

const readme = readFileSync(readmePath, "utf8");
const missing = [...read.keys()].filter((name) => !new RegExp(`\\b${name}\\b`).test(readme)).sort();

if (missing.length > 0) {
  const annotate = process.env["GITHUB_ACTIONS"] ? "::error::" : "error: ";
  for (const name of missing) {
    console.error(`${annotate}${service} reads ${name} in ${[...read.get(name)].sort().join(", ")} and its README never names it`);
  }
  console.error(
    `${annotate}${missing.length} undocumented variable(s). An operator configures this service from its README, so a variable missing from it is a deployment that silently takes a default.`,
  );
  process.exit(1);
}

console.log(`clean: all ${read.size} environment variable(s) ${service} reads are named in its README`);
