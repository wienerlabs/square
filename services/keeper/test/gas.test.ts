import { describe, expect, it } from "vitest";
import {
  finalizeGasDefaults,
  gasAssumption,
  GATED_FINALIZE_DECIDED_GAS,
  GATED_FINALIZE_GAS,
  MODULELESS_FINALIZE_DECIDED_GAS,
  MODULELESS_FINALIZE_GAS,
  readComplianceGate,
  describeGate,
} from "../src/gas.js";
import { minimumProfitableBudget } from "../src/decide.js";

const GWEI = 1_000_000_000n;
const ARC_GAS_PRICE = 22n * GWEI;
const DEFAULT_FEE_BP = 50;
const MARGIN_BPS = 2_000;

describe("which gas a finalize is assumed to cost", () => {
  it("takes the gated figure when a module is installed and today's figure when none is", () => {
    expect(finalizeGasDefaults(false)).toEqual({
      finalizeGas: MODULELESS_FINALIZE_GAS,
      finalizeDecidedGas: MODULELESS_FINALIZE_DECIDED_GAS,
    });
    expect(finalizeGasDefaults(true)).toEqual({
      finalizeGas: GATED_FINALIZE_GAS,
      finalizeDecidedGas: GATED_FINALIZE_DECIDED_GAS,
    });
    expect(GATED_FINALIZE_GAS).toBeGreaterThan(1_052_107n);
  });

  it("moves the break-even budget past the jobs the moduleless figure took at a loss", () => {
    const moduleless = minimumProfitableBudget(DEFAULT_FEE_BP, ARC_GAS_PRICE, MODULELESS_FINALIZE_GAS, MARGIN_BPS);
    const gated = minimumProfitableBudget(DEFAULT_FEE_BP, ARC_GAS_PRICE, GATED_FINALIZE_GAS, MARGIN_BPS);

    expect(moduleless).toBe(2_956_800n);
    expect(gated).toBe(5_755_200n);
    expect(gated).toBeGreaterThan(3_000_000n);
    expect(gated).toBeLessThan(6_000_000n);
  });
});

describe("the moving average of the receipts", () => {
  it("is the estimate only until the first receipt, then follows the chain", () => {
    const gas = gasAssumption({ finalizeGas: GATED_FINALIZE_GAS, finalizeDecidedGas: GATED_FINALIZE_DECIDED_GAS, samples: 3 });

    expect(gas.assumed("finalize")).toBe(GATED_FINALIZE_GAS);
    expect(gas.source("finalize")).toBe("default");

    gas.record("finalize", 1_052_107n);
    expect(gas.assumed("finalize")).toBe(1_052_107n);
    expect(gas.source("finalize")).toBe("receipts");
    expect(gas.assumed("finalizeDecided")).toBe(GATED_FINALIZE_DECIDED_GAS);

    gas.record("finalize", 1_000_000n);
    gas.record("finalize", 900_000n);
    expect(gas.assumed("finalize")).toBe(984_036n);

    gas.record("finalize", 900_000n);
    expect(gas.seen("finalize")).toBe(3);
    expect(gas.assumed("finalize")).toBe(933_334n);
  });

  it("is not moved by a receipt when the operator named the number", () => {
    const gas = gasAssumption({ finalizeGas: 700_000n, finalizeDecidedGas: 800_000n, pinned: true });

    gas.record("finalize", 1_052_107n);

    expect(gas.assumed("finalize")).toBe(700_000n);
    expect(gas.source("finalize")).toBe("operator");
    expect(gas.seen("finalize")).toBe(0);
  });

  it("ignores a receipt that reports no gas and keeps a window of zero off", () => {
    const gas = gasAssumption({ finalizeGas: 450_000n, finalizeDecidedGas: 500_000n });
    gas.record("finalize", 0n);
    expect(gas.assumed("finalize")).toBe(450_000n);

    const noWindow = gasAssumption({ finalizeGas: 450_000n, finalizeDecidedGas: 500_000n, samples: 0 });
    noWindow.record("finalize", 1_052_107n);
    expect(noWindow.assumed("finalize")).toBe(450_000n);
    expect(noWindow.source("finalize")).toBe("default");
  });
});

describe("reading the gate when the chain will not answer", () => {
  const noteTaking = () => {
    const notes: Array<{ event: string; fields: Record<string, unknown> }> = [];
    return {
      notes,
      logger: { warn: (event: string, fields: Record<string, unknown>) => notes.push({ event, fields }) },
    };
  };

  it("does not throw, so the process reaches the port it serves health on", async () => {
    const { logger, notes } = noteTaking();
    const dead = {
      complianceModule: async () => {
        throw new Error("HTTP request failed. URL: http://127.0.0.1:9/");
      },
      complianceTolerance: async () => 3_600n,
    };

    const gate = await readComplianceGate(dead as never, logger as never);

    expect(gate).toEqual({ module: null, tolerance: null, gated: true, known: false });
    expect(notes.map((note) => note.event)).toEqual(["keeper.gate_unknown"]);
  });

  it("assumes the gated figure when it cannot tell, because that is the assumption that costs nothing", async () => {
    const { logger } = noteTaking();
    const dead = {
      complianceModule: async () => {
        throw new Error("fetch failed");
      },
      complianceTolerance: async () => 3_600n,
    };

    const gate = await readComplianceGate(dead as never, logger as never);

    expect(finalizeGasDefaults(gate.gated)).toEqual({
      finalizeGas: GATED_FINALIZE_GAS,
      finalizeDecidedGas: GATED_FINALIZE_DECIDED_GAS,
    });
    expect(describeGate(gate)).toBe("the hook could not be read, so a compliance module is assumed");
  });

  it("reads a live chain exactly as before", async () => {
    const { logger, notes } = noteTaking();
    const live = {
      complianceModule: async () => "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e" as const,
      complianceTolerance: async () => 7_200n,
    };

    const gate = await readComplianceGate(live as never, logger as never);

    expect(gate).toEqual({
      module: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
      tolerance: 7_200n,
      gated: true,
      known: true,
    });
    expect(notes).toEqual([]);
  });

  it("reads a moduleless chain as moduleless, and asks it for no tolerance", async () => {
    const { logger } = noteTaking();
    let toleranceAsked = 0;
    const live = {
      complianceModule: async () => null,
      complianceTolerance: async () => {
        toleranceAsked += 1;
        return 3_600n;
      },
    };

    const gate = await readComplianceGate(live as never, logger as never);

    expect(gate).toEqual({ module: null, tolerance: null, gated: false, known: true });
    expect(toleranceAsked).toBe(0);
    expect(finalizeGasDefaults(gate.gated).finalizeGas).toBe(MODULELESS_FINALIZE_GAS);
  });
});
