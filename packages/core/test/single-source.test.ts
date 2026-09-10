import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANVIL_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  deploymentFor,
  deploymentFromJson,
} from "../src/deployments.js";

/**
 * #49 asks that an address, a chain id and an RPC endpoint come from one place.
 * Making that true once is easy; keeping it true is what this file is for. It
 * reads the repository the way a reviewer would — looking for a second literal
 * copy of a value that already has a home — and names the file that added one.
 *
 * The rule is about *declarations*, not uses: any module may import the value,
 * and comments are stripped before the scan, because prose that mentions a
 * chain id is documentation rather than a second copy of the configuration.
 */

const repoRoot = resolve(__dirname, "..", "..", "..");
const SOURCE_ROOTS = ["packages", "services", "app/src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/** The one file allowed to spell these values out. */
const DECLARATION_SITE = "packages/core/src/deployments.ts";

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    // Tests and scripts pin values on purpose — a fixture that read its own
    // expectation from the code under test would assert nothing.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
    if (full.includes("/test/") || full.includes("/scripts/")) continue;
    yield full;
  }
}

/** Block and line comments removed; string and template literals kept. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function filesContaining(needle: RegExp): string[] {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      if (needle.test(withoutComments(readFileSync(file, "utf8")))) found.push(relative(repoRoot, file));
    }
  }
  return found.sort();
}

describe("one declaration site", () => {
  it("finds source to scan at all", () => {
    // A path typo would make every assertion below pass against an empty set.
    expect(filesContaining(/@squaresdk\/core/).length).toBeGreaterThan(5);
  });

  it("declares the Arc chain id once", () => {
    expect(filesContaining(new RegExp(String(ARC_TESTNET_CHAIN_ID)))).toEqual([DECLARATION_SITE]);
  });

  it("declares the USDC address once", () => {
    const usdc = deploymentFor(ARC_TESTNET_CHAIN_ID).usdc;
    expect(filesContaining(new RegExp(usdc, "i"))).toEqual([DECLARATION_SITE]);
  });

  it("declares the IdentityRegistry address once", () => {
    const registry = deploymentFor(ARC_TESTNET_CHAIN_ID).identityRegistry;
    expect(filesContaining(new RegExp(registry, "i"))).toEqual([DECLARATION_SITE]);
  });

  it("declares the Arc RPC endpoint once", () => {
    expect(filesContaining(/rpc\.testnet\.arc\.io/)).toEqual([DECLARATION_SITE]);
  });
});

/**
 * The nine addresses live in two files, and this is what keeps them equal.
 *
 * `deployments.ts` says the addresses come out of
 * `contracts/deployments/<chainId>.json`, which a forge script writes. It does
 * not read that file — it cannot, because the JSON is not shipped with the
 * package — so it holds a copy, and a copy nobody compares is a copy that
 * drifts. Five of the nine moved twice in two days across the redeploys of
 * 2026-09-08 and 2026-09-09.
 *
 * The literal-duplication rule above cannot catch this one: the JSON is not a
 * second *declaration* of an address, it is the output of the deploy that
 * produced it, and forbidding it would delete the source of truth. So this
 * checks the weaker and correct thing — that the copy still equals the source.
 *
 * Reported separately as square#168.
 */
describe("the copy still equals the deployment file", () => {
  const deploymentFile = (chainId: number): string =>
    join(repoRoot, "contracts", "deployments", `${chainId}.json`);

  it("matches Arc testnet's file, address for address", () => {
    const onDisk = deploymentFromJson(JSON.parse(readFileSync(deploymentFile(ARC_TESTNET_CHAIN_ID), "utf8")));
    expect(deploymentFor(ARC_TESTNET_CHAIN_ID)).toEqual(onDisk);
  });

  /**
   * 31337.json is gitignored — a local deploy writes it — so this asserts only
   * when it is there. It says which of the two happened rather than passing
   * quietly either way, because a suite that reports green having checked
   * nothing is the failure docs/ci.md is about.
   */
  it("matches the local chain's file when a local deploy has written one", () => {
    const path = deploymentFile(ANVIL_CHAIN_ID);
    if (!existsSync(path)) {
      expect(deploymentFor(ANVIL_CHAIN_ID).chainId).toBe(ANVIL_CHAIN_ID);
      console.warn(`no ${path}: run DeployLocal to check the anvil copy too`);
      return;
    }
    expect(deploymentFor(ANVIL_CHAIN_ID)).toEqual(
      deploymentFromJson(JSON.parse(readFileSync(path, "utf8"))),
    );
  });
});
