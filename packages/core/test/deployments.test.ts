import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
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

const OPTIONAL_FIELDS = ["complianceModule", "screeningRegistry"] as const satisfies ReadonlyArray<keyof SquareDeployment>;

const constant = deploymentFor(ARC_TESTNET_CHAIN_ID);
const fromFile = deploymentFromJson(JSON.parse(readFileSync(deploymentPath, "utf8")));

describe(`the Arc Testnet constant and contracts/deployments/${ARC_TESTNET_CHAIN_ID}.json`, () => {
  it.each(FIELDS)("agree on %s", (field) => {
    expect(constant[field]).toBe(fromFile[field]);
  });

  it("agree on every field, so a redeploy cannot update one source and leave the other behind", () => {
    expect(constant).toEqual(fromFile);
  });

  it.each(OPTIONAL_FIELDS)("agree on %s, present in both sources or in neither", (field) => {
    expect(field in constant).toBe(field in fromFile);
    expect(constant[field]).toBe(fromFile[field]);
  });

  it("are compared field by field over the whole of SquareDeployment", () => {
    const required = [...FIELDS].sort();
    const optional: readonly string[] = OPTIONAL_FIELDS;
    for (const source of [constant, fromFile]) {
      expect(Object.keys(source).sort().filter((key) => !optional.includes(key))).toEqual(required);
    }
  });
});

// #250. `DeployLocal` writes a ComplianceModule and the Arc record carries none,
// so the field is read when it is there and left out, not set to undefined,
// when it is not.
describe("deploymentFromJson and the compliance module", () => {
  const record = JSON.parse(readFileSync(deploymentPath, "utf8")) as Record<string, unknown>;
  const module = "0x00000000000000000000000000000000000000c0";

  it("reads ComplianceModule when the record names one", () => {
    expect(deploymentFromJson({ ...record, ComplianceModule: module }).complianceModule).toBe(getAddress(module));
  });

  it("leaves the field out when the record names none", () => {
    expect("complianceModule" in deploymentFromJson(record)).toBe(false);
  });

  it("refuses a ComplianceModule that is not an address", () => {
    expect(() => deploymentFromJson({ ...record, ComplianceModule: "0x1234" })).toThrow("ComplianceModule is not an address");
  });

  // square#368: the screening registry the same way. `DeployLocal` writes it
  // and the Arc record carries none.
  it("reads ScreeningRegistry the same way, and leaves it out when the record names none", () => {
    const registry = "0x00000000000000000000000000000000000005c4";
    expect(deploymentFromJson({ ...record, ScreeningRegistry: registry }).screeningRegistry).toBe(getAddress(registry));
    expect("screeningRegistry" in deploymentFromJson(record)).toBe(false);
    expect(() => deploymentFromJson({ ...record, ScreeningRegistry: "0x1234" })).toThrow("ScreeningRegistry is not an address");
  });
});
