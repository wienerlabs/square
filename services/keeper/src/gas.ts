import type { Address } from "viem";
import type { Logger } from "@squaresdk/observability";
import type { SquareClient } from "@squaresdk/core";

export type SettlementAction = "finalize" | "finalizeDecided";

// The estimate a keeper starts from before its first receipt; from the first
// receipt on the moving average below is what it uses. Since square#405 every
// settled job writes an ERC-8004 evidence record from the hook's afterAction,
// which the Foundry suite measures at +86 690 gas on a moduleless finalize (the
// validation write is new there) and +29 359 on a gated one (the write was
// already there; the evidence read and event are the difference). The
// moduleless figure is the CI runner's reading of test_gas_finalizeWithHook
// rounded up; the gated pair is the 1 052 107 receipt of #344's anvil
// measurement plus that delta, rounded up. Being high here costs a keeper
// work it could have taken; being low costs it money (docs/design/keeper-economics.md).
export const MODULELESS_FINALIZE_GAS = 560_000n;
export const MODULELESS_FINALIZE_DECIDED_GAS = 610_000n;
export const GATED_FINALIZE_GAS = 1_090_000n;
export const GATED_FINALIZE_DECIDED_GAS = 1_140_000n;
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

export interface ComplianceGate {
  module: Address | null;
  tolerance: bigint | null;
  gated: boolean;
  known: boolean;
}

export async function readComplianceGate(
  client: Pick<SquareClient, "complianceModule" | "complianceTolerance">,
  logger: Pick<Logger, "warn">,
): Promise<ComplianceGate> {
  try {
    const module = await client.complianceModule();
    const tolerance = module === null ? null : await client.complianceTolerance();
    return { module, tolerance, gated: module !== null, known: true };
  } catch (error) {
    logger.warn("keeper.gate_unknown", {
      reason:
        `the hook could not be read at startup (${error instanceof Error ? error.message : String(error)}), ` +
        "so the keeper assumes a compliance module is installed and starts anyway. That assumption is the safe " +
        "one of the two: the gated figure skips work the keeper could have taken, the moduleless figure takes " +
        "work at a loss, and the first receipt corrects either. The keeper answers /health as unhealthy while " +
        "the chain is unreachable rather than refusing to start, because an operator needs it to say why.",
    });
    return { module: null, tolerance: null, gated: true, known: false };
  }
}

export function describeGate(gate: ComplianceGate): string {
  if (!gate.known) return "the hook could not be read, so a compliance module is assumed";
  return gate.module === null
    ? "no compliance module is installed"
    : `a compliance module is installed at ${gate.module}`;
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
