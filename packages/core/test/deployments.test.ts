import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentFor,
  deploymentFromJson,
  type SquareDeployment,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = join(packageRoot, "..", "..", "contracts", "deployments", `${ARC_TESTNET_CHAIN_ID}.json`);

const FIELDS = [
  "chainId",
  "squareJob",
  "keeperEvaluator",
  "arbitration",
  "claimMarket",
  "squareHook",
  "usdc",
  "identityRegistry",
  "reputationRegistry",
  "validationRegistry",
] as const satisfies ReadonlyArray<keyof SquareDeployment>;

const constant = deploymentFor(ARC_TESTNET_CHAIN_ID);
const fromFile = deploymentFromJson(JSON.parse(readFileSync(deploymentPath, "utf8")));

describe(`the Arc Testnet constant and contracts/deployments/${ARC_TESTNET_CHAIN_ID}.json`, () => {
  it.each(FIELDS)("agree on %s", (field) => {
    expect(constant[field]).toBe(fromFile[field]);
  });

  it("agree on every field, so a redeploy cannot update one source and leave the other behind", () => {
    expect(constant).toEqual(fromFile);
  });

  it("are compared field by field over the whole of SquareDeployment", () => {
    const covered = [...FIELDS].sort();
    expect(Object.keys(constant).sort()).toEqual(covered);
    expect(Object.keys(fromFile).sort()).toEqual(covered);
  });
});
