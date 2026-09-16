export type SettlementAction = "finalize" | "finalizeDecided";

export const MODULELESS_FINALIZE_GAS = 450_000n;
export const MODULELESS_FINALIZE_DECIDED_GAS = 500_000n;
export const GATED_FINALIZE_GAS = 1_060_000n;
export const GATED_FINALIZE_DECIDED_GAS = 1_110_000n;
export const DEFAULT_FINALIZE_GAS_SAMPLES = 5;

export type GasSource = "operator" | "receipts" | "default";

export interface FinalizeGasDefaults {
  finalizeGas: bigint;
  finalizeDecidedGas: bigint;
}

export function finalizeGasDefaults(gated: boolean): FinalizeGasDefaults {
  return gated
    ? { finalizeGas: GATED_FINALIZE_GAS, finalizeDecidedGas: GATED_FINALIZE_DECIDED_GAS }
    : { finalizeGas: MODULELESS_FINALIZE_GAS, finalizeDecidedGas: MODULELESS_FINALIZE_DECIDED_GAS };
}

export interface GasAssumptionOptions {
  finalizeGas: bigint;
  finalizeDecidedGas: bigint;
  pinned?: boolean;
  samples?: number;
}

export interface GasAssumption {
  assumed(action: SettlementAction): bigint;
  record(action: SettlementAction, gasUsed: bigint): void;
  source(action: SettlementAction): GasSource;
  seen(action: SettlementAction): number;
}

export function gasAssumption(options: GasAssumptionOptions): GasAssumption {
  const pinned = options.pinned === true;
  const keep = Math.max(0, options.samples ?? DEFAULT_FINALIZE_GAS_SAMPLES);
  const constants: Record<SettlementAction, bigint> = {
    finalize: options.finalizeGas,
    finalizeDecided: options.finalizeDecidedGas,
  };
  const receipts: Record<SettlementAction, bigint[]> = { finalize: [], finalizeDecided: [] };

  const average = (action: SettlementAction): bigint | null => {
    const window = receipts[action];
    if (window.length === 0) return null;
    const total = window.reduce((sum, gas) => sum + gas, 0n);
    const count = BigInt(window.length);
    return (total + count - 1n) / count;
  };

  return {
    assumed(action) {
      if (pinned) return constants[action];
      return average(action) ?? constants[action];
    },
    record(action, gasUsed) {
      if (pinned || keep === 0 || gasUsed <= 0n) return;
      const window = receipts[action];
      window.push(gasUsed);
      if (window.length > keep) window.splice(0, window.length - keep);
    },
    source(action) {
      if (pinned) return "operator";
      return receipts[action].length > 0 ? "receipts" : "default";
    },
    seen(action) {
      return receipts[action].length;
    },
  };
}
