"use client";

import type { TransactionResult } from "@squaresdk/core";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";

export type TxState =
  | { status: "idle" }
  | { status: "pending"; label: string }
  | { status: "success"; label: string; hash: Hex }
  | { status: "error"; label: string; message: string };

interface TxContextValue {
  state: TxState;
  busy: boolean;
  run: <T extends TransactionResult>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  notify: (state: TxState) => void;
  dismiss: () => void;
}

const TxContext = createContext<TxContextValue | null>(null);

export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.name === "ProviderNotFoundError") return "No injected wallet was found in this browser.";
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      return name ? `Reverted with ${name}` : reverted.shortMessage;
    }
    return error.shortMessage;
  }
  if (error instanceof Error) {
    if (error.name === "ProviderNotFoundError") return "No injected wallet was found in this browser.";
    return error.message;
  }
  return "Unknown error";
}

export function TxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const queryClient = useQueryClient();

  const run = useCallback(
    async <T extends TransactionResult>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setState({ status: "pending", label });
      try {
        const result = await fn();
        setState({ status: "success", label, hash: result.hash });
        await queryClient.invalidateQueries();
        return result;
      } catch (error) {
        setState({ status: "error", label, message: describeError(error) });
        return undefined;
      }
    },
    [queryClient],
  );

  const notify = useCallback((next: TxState) => setState(next), []);
  const dismiss = useCallback(() => setState({ status: "idle" }), []);

  const value = useMemo<TxContextValue>(
    () => ({ state, busy: state.status === "pending", run, notify, dismiss }),
    [state, run, notify, dismiss],
  );

  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

export function useTx(): TxContextValue {
  const context = useContext(TxContext);
  if (!context) throw new Error("useTx must be used inside TxProvider");
  return context;
}
