#!/usr/bin/env node
// The @squaresdk packages to npm, in dependency order (square#356,
// docs/decisions/distribution-channel.md).
//
//   node scripts/publish.mjs                  pack every publishable package, check the tarballs, print them
//   node scripts/publish.mjs --build          first install and build each one, in dependency order
//   node scripts/publish.mjs --install-check  ...and install all of them into an empty project, import each, run the bins
//   node scripts/publish.mjs --expect-version 0.1.0   refuse unless every package declares that version
//   node scripts/publish.mjs --publish        ...and publish whichever version the registry does not hold yet
//   node scripts/publish.mjs --set-version 0.1.1      write that version into every publishable package and its lockfile, and stop
//
// The packages depend on each other as `file:../core`, which is what makes a
// clone build without a registry; a tarball carrying `file:` would make every
// install fail. So each package.json is rewritten for the length of its pack
// (`file:../x` becomes `^<x's version>`) and put back byte for byte, and the
// root LICENSE is put beside it for the same span, since npm reads it from
// the package's own root. Nothing here bumps a version: a publish is the
// version each package.json declares, and one the registry already holds is
// skipped, so a re-run after a partial failure publishes the rest.
//
// Needs `dist/` built in every package (`npm run build`), and for --publish
// an npm token in NODE_AUTH_TOKEN (the workflow passes NPM_TOKEN as that).
// --build installs the way CI does, `npm install --install-links`, which
// rewrites a lockfile that was written with links (`../core`) into one with
// copies; in a clone, `git checkout -- packages/*/package-lock.json` after.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let publish = false;
let installCheck = false;
let build = false;
let expectVersion;
let setVersion;
let distTag = "latest";
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--publish") publish = true;
  else if (arg === "--install-check") installCheck = true;
  else if (arg === "--build") build = true;
  else if (arg === "--expect-version") expectVersion = process.argv[++i];
  else if (arg === "--set-version") setVersion = process.argv[++i];
  else if (arg === "--tag") distTag = process.argv[++i] ?? distTag;
  else throw new Error(`unknown argument ${arg}`);
}

/** Every directory under packages/ that is not private, ordered so that a package comes after everything it depends on. */
function publishablePackages() {
  const dir = join(root, "packages");
  const all = new Map();
  for (const name of execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n")) {
    const file = join(dir, name, "package.json");
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (json.private === true) continue;
    all.set(json.name, { dir: join(dir, name), json, file });
  }
  const ordered = [];
  const seen = new Set();
  const visit = (name, trail) => {
    if (seen.has(name)) return;
    if (trail.includes(name)) throw new Error(`dependency cycle: ${[...trail, name].join(" -> ")}`);
    const pkg = all.get(name);
    for (const [dep, spec] of Object.entries(pkg.json.dependencies ?? {})) {
      if (!spec.startsWith("file:")) continue;
      if (!all.has(dep)) throw new Error(`${name} depends on ${dep} as ${spec}, which is not a publishable package`);
      visit(dep, [...trail, name]);
    }
    seen.add(name);
    ordered.push(pkg);
  };
  for (const name of [...all.keys()].sort()) visit(name, []);
  return ordered;
}

/** The package.json a tarball carries: every `file:` sibling as a caret range on the sibling's declared version. */
function publishedManifest(pkg, byName) {
  const json = structuredClone(pkg.json);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(json[field] ?? {})) {
      if (!spec.startsWith("file:")) continue;
      const sibling = byName.get(dep);
      if (!sibling) throw new Error(`${pkg.json.name}: ${dep} is ${spec} and not a publishable package`);
      json[field][dep] = `^${sibling.json.version}`;
    }
  }
  // devDependencies never reach an installer; a `file:` there is harmless but is dropped for cleanliness.
  delete json.devDependencies;
  return json;
}

function npm(cwd, argv, options = {}) {
  const result = spawnSync("npm", argv, { cwd, encoding: "utf8", env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`npm ${argv.join(" ")} in ${cwd} exited ${result.status}\n${result.stderr}`);
  }
  return result;
}

/** What a tarball must carry, from its own manifest: the entry points, the types, every bin, and the usual three. */
function requiredFiles(json) {
  const files = new Set(["package.json", "README.md", "LICENSE"]);
  const strip = (p) => p.replace(/^\.\//, "");
  if (json.main) files.add(strip(json.main));
  if (json.types) files.add(strip(json.types));
  for (const target of Object.values(json.bin ?? {})) files.add(strip(target));
  const walk = (entry) => {
    if (typeof entry === "string") files.add(strip(entry));
    else if (entry && typeof entry === "object") Object.values(entry).forEach(walk);
  };
  walk(json.exports ?? {});
  return files;
}

/** Pack one package with its published manifest in place, verify the tarball, and put everything back. */
function pack(pkg, byName, outDir) {
  const original = readFileSync(pkg.file);
  const licenseHere = join(pkg.dir, "LICENSE");
  const licenseWasThere = existsSync(licenseHere);
  if (!existsSync(join(pkg.dir, "dist"))) throw new Error(`${pkg.json.name}: no dist/; run npm run build first`);
  const manifest = publishedManifest(pkg, byName);
  try {
    writeFileSync(pkg.file, `${JSON.stringify(manifest, null, 2)}\n`);
    if (!licenseWasThere) copyFileSync(join(root, "LICENSE"), licenseHere);
    const result = npm(pkg.dir, ["pack", "--json", "--pack-destination", outDir]);
    const [packed] = JSON.parse(result.stdout);
    const names = new Set(packed.files.map((f) => f.path));
    const missing = [...requiredFiles(manifest)].filter((f) => !names.has(f));
    if (missing.length > 0) throw new Error(`${pkg.json.name}: the tarball lacks ${missing.join(", ")}`);
    const allowed = new Set(["package.json", "README.md", "LICENSE"]);
    const roots = (manifest.files ?? []).map((f) => f.replace(/\/$/, ""));
    const stray = [...names].filter((f) => !allowed.has(f) && !roots.some((r) => f === r || f.startsWith(`${r}/`)));
    if (stray.length > 0) throw new Error(`${pkg.json.name}: the tarball carries files outside "files": ${stray.slice(0, 5).join(", ")}`);
    const tarball = join(outDir, packed.filename);
    const inside = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
    const fileSpecs = Object.entries(inside.dependencies ?? {}).filter(([, spec]) => String(spec).startsWith("file:"));
    if (fileSpecs.length > 0) throw new Error(`${pkg.json.name}: the packed manifest still says ${fileSpecs.map(([d, s]) => `${d}: ${s}`).join(", ")}`);
    return { tarball, files: packed.entryCount, unpackedSize: packed.unpackedSize, size: packed.size, manifest: inside };
  } finally {
    writeFileSync(pkg.file, original);
    if (!licenseWasThere) rmSync(licenseHere, { force: true });
  }
}

function alreadyPublished(name, version) {
  const result = npm(root, ["view", `${name}@${version}`, "version", "--json"], { allowFailure: true });
  if (result.status !== 0) return false; // E404: no such version (or no such package yet)
  const out = result.stdout.trim();
  return out !== "" && out !== "[]";
}

/** Every tarball into one empty project in one install, so the caret ranges resolve to the tarballs beside them and not to the registry. */
function checkInstall(packed) {
  const project = mkdtempSync(join(tmpdir(), "squaresdk-install-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "install-check", private: true, type: "module" }, null, 2));
  npm(project, ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...packed.map((p) => p.tarball)]);
  const lines = [];
  for (const { manifest } of packed) {
    if (manifest.main || manifest.exports) {
      const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(manifest.name)}); console.log(Object.keys(m).length)`], { cwd: project, encoding: "utf8" });
      if (probe.status !== 0) throw new Error(`import ${manifest.name} failed in the installed project:\n${probe.stderr}`);
      lines.push(`  import ${manifest.name}: ${probe.stdout.trim()} export(s)`);
    }
  }
  const bin = (name, argv, env, expect) => {
    const run = spawnSync(join(project, "node_modules", ".bin", name), argv, { cwd: project, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
    const text = `${run.stdout}${run.stderr}`;
    if (!expect(run.status, text)) throw new Error(`${name} ${argv.join(" ")} in the installed project: exit ${run.status}\n${text.slice(0, 800)}`);
    lines.push(`  ${name} ${argv.join(" ")}: exit ${run.status}, ${text.trim().split("\n")[0].slice(0, 100)}`);
  };
  // The three binaries resolve their dependencies and answer; none needs a chain for this.
  bin("square", ["--version"], {}, (status, text) => status === 0 && /\d+\.\d+\.\d+/.test(text));
  bin("square-hosted", [], {}, (status, text) => status === 1 && text.includes("usage: square-hosted"));
  bin("square-mcp", [], { SQUARE_CHAIN_ID: "31337", SQUARE_RPC_URL: "http://127.0.0.1:9" }, (status, text) => status === 1 && /ECONNREFUSED|fetch failed|could not|refused/i.test(text));
  bin("square-data", [], {}, (_status, text) => text.includes("usage: square-data"));
  rmSync(project, { recursive: true, force: true });
  return lines;
}

const packages = publishablePackages();
const byName = new Map(packages.map((p) => [p.json.name, p]));
if (setVersion !== undefined) {
  // The lockstep bump: the version field of every publishable package.json,
  // and of its lockfile's two copies of it, so `npm install` afterwards has
  // nothing to rewrite. The `file:` siblings need no change; they are paths.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(setVersion)) throw new Error(`${setVersion} is not a version`);
  for (const pkg of packages) {
    const text = readFileSync(pkg.file, "utf8");
    writeFileSync(pkg.file, text.replace(/("version":\s*")[^"]+(")/, `$1${setVersion}$2`));
    const lock = join(pkg.dir, "package-lock.json");
    if (existsSync(lock)) {
      const json = JSON.parse(readFileSync(lock, "utf8"));
      json.version = setVersion;
      if (json.packages?.[""]) json.packages[""].version = setVersion;
      // The siblings installed as `file:` copies carry their version here too
      // (a lockfile written with links instead carries none, and gets none).
      for (const [path, entry] of Object.entries(json.packages ?? {})) {
        if (path.startsWith("node_modules/@squaresdk/") && byName.has(path.slice("node_modules/".length)) && entry.version !== undefined) entry.version = setVersion;
      }
      writeFileSync(lock, `${JSON.stringify(json, null, 2)}\n`);
    }
    console.log(`  ${pkg.json.name}: ${pkg.json.version} -> ${setVersion}`);
  }
  process.exit(0);
}
if (expectVersion !== undefined) {
  const odd = packages.filter((p) => p.json.version !== expectVersion).map((p) => `${p.json.name}@${p.json.version}`);
  if (odd.length > 0) throw new Error(`the packages are published in lockstep and the release is ${expectVersion}; these say otherwise: ${odd.join(", ")}`);
}
if (build) {
  // In dependency order, so each package's `file:` siblings are built before
  // `--install-links` copies them in; the previous copies go first, since npm
  // does not refresh a copy whose version did not change.
  for (const pkg of packages) {
    rmSync(join(pkg.dir, "node_modules", "@squaresdk"), { recursive: true, force: true });
    npm(pkg.dir, ["install", "--install-links", "--no-audit", "--no-fund"]);
    npm(pkg.dir, ["run", "build"]);
    console.log(`  built ${pkg.json.name}`);
  }
}
const outDir = mkdtempSync(join(tmpdir(), "squaresdk-pack-"));
const rows = [];
const packed = [];
for (const pkg of packages) {
  const result = pack(pkg, byName, outDir);
  packed.push(result);
  rows.push(`  ${pkg.json.name.padEnd(28)} ${pkg.json.version.padEnd(8)} ${String(result.files).padStart(4)} files  ${String(Math.round(result.unpackedSize / 1024)).padStart(6)} KiB unpacked  ${basename(result.tarball)}`);
}
console.log(`packed ${packed.length} package(s) into ${outDir}, in dependency order:\n${rows.join("\n")}`);

if (installCheck) {
  console.log("installing every tarball into an empty project:");
  console.log(checkInstall(packed).join("\n"));
}

if (publish) {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error("--publish needs NODE_AUTH_TOKEN (the workflow passes the NPM_TOKEN secret as it)");
  for (const { tarball, manifest } of packed) {
    if (alreadyPublished(manifest.name, manifest.version)) {
      console.log(`  ${manifest.name}@${manifest.version}: already on the registry, skipped`);
      continue;
    }
    npm(root, ["publish", tarball, "--access", "public", "--provenance", "--tag", distTag]);
    console.log(`  ${manifest.name}@${manifest.version}: published (${distTag})`);
  }
}
