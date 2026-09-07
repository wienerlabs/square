import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import {
  measurementsPath,
  renderMarkdownTable,
  runMeasurement,
  serializeMeasurement,
  type Measurement,
} from "../scripts/measure.js";
import { ARC_OBSERVED_GAS_PRICE_WEI } from "../src/constants.js";

const rpcUrl = inject("rpcUrl");
const deployment = inject("deployment");

describe("EOA versus UserOperation cost of the provider's setBudget and submit", () => {
  let measurement: Measurement;

  it("produces six positive gas figures and a positive overhead for every UserOperation path", async () => {
    measurement = await runMeasurement({ rpcUrl, deployment });

    expect(measurement.rows).toHaveLength(6);
    for (const row of measurement.rows) {
      expect(row.gasUsed > 0n).toBe(true);
      expect(row.effectiveGasPrice > 0n).toBe(true);
      if (row.path === "eoa") {
        expect(row.actualGasUsed).toBeNull();
      } else {
        expect(row.actualGasUsed !== null && row.actualGasUsed > 0n).toBe(true);
        expect(row.actualGasCost !== null && row.actualGasCost > 0n).toBe(true);
      }
    }
    expect(measurement.overhead).toHaveLength(4);
    for (const overhead of measurement.overhead) {
      expect(overhead.gas > 0n).toBe(true);
      expect(Number(overhead.usdc)).toBeGreaterThan(0);
    }
    const deploying = measurement.overhead.filter((entry) => entry.path === "userop-deploying");
    const deployed = measurement.overhead.filter((entry) => entry.path === "userop-deployed");
    for (const entry of deploying) {
      const same = deployed.find((candidate) => candidate.operation === entry.operation);
      expect(same !== undefined && entry.gas > same.gas).toBe(true);
    }
    expect(measurement.gasPriceWei).toBe(ARC_OBSERVED_GAS_PRICE_WEI);
  });

  it("writes measurements.json next to the package manifest and renders a markdown table", () => {
    writeFileSync(measurementsPath, serializeMeasurement(measurement));
    expect(existsSync(measurementsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(measurementsPath, "utf8")) as { rows: unknown[]; gasPriceWei: string };
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.gasPriceWei).toBe(ARC_OBSERVED_GAS_PRICE_WEI.toString());

    const table = renderMarkdownTable(measurement);
    expect(table.split("\n")).toHaveLength(8);
    expect(table).toContain("`setBudget`");
    expect(table).toContain("`submit`");
    console.log(`\n${table}\n`);
  });
});
