import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const abiDir = join(here, "..", "src", "abi");
const docPath = join(here, "..", "..", "..", "docs", "design", "storage-and-events.md");

const notASquareContract = new Set(["index.ts", "erc20.ts"]);

function abiOf(file) {
  const source = readFileSync(join(abiDir, file), "utf8");
  const opening = source.indexOf("[");
  const closing = source.lastIndexOf("]");
  if (opening === -1 || closing === -1) throw new Error(`${file} does not hold an ABI array`);
  return JSON.parse(source.slice(opening, closing + 1));
}

const modules = readdirSync(abiDir)
  .filter((file) => file.endsWith(".ts") && !notASquareContract.has(file))
  .sort();

if (modules.length === 0) {
  console.error("error: no ABI modules found in packages/core/src/abi, refusing to report a pass");
  process.exit(1);
}

const documentation = readFileSync(docPath, "utf8");
const documented = (name) => new RegExp(`\\b${name}\\b`).test(documentation);

const missing = [];
let checked = 0;
for (const file of modules) {
  const contract = file.replace(/\.ts$/, "");
  const events = [...new Set(abiOf(file).filter((entry) => entry.type === "event").map((entry) => entry.name))].sort();
  for (const name of events) {
    checked += 1;
    if (!documented(name)) missing.push(`${contract}.${name}`);
  }
}

if (missing.length > 0) {
  const annotate = process.env["GITHUB_ACTIONS"] ? "::error::" : "error: ";
  for (const entry of missing) {
    console.error(`${annotate}${entry} is emitted by the contracts and named nowhere in docs/design/storage-and-events.md`);
  }
  console.error(
    `${annotate}${missing.length} undocumented event(s). services/indexer/README.md calls that document the specification the reducer follows, so an event missing from it is a specification with a hole in it. Add a row for each, then rerun this check.`,
  );
  process.exit(1);
}

console.log(`clean: ${checked} event declaration(s) across ${modules.length} ABI module(s) are documented in docs/design/storage-and-events.md`);
