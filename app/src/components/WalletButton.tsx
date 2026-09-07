"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { shortAddress } from "@/lib/format";
import { describeError, useTx } from "@/lib/tx";
import { activeChain } from "@/lib/wagmi";
import { ArcNetworkMark } from "./marks";

const pill =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-iris px-4 text-caption font-medium text-carbon transition-colors hover:bg-iris/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender disabled:cursor-not-allowed disabled:bg-mist disabled:text-ash";

function describeConnector(connector: Connector): string {
  if (connector.id === "injected") return "Browser wallet";
  return connector.name;
}

export function usableConnectors(connectors: readonly Connector[]): Connector[] {
  const discovered = connectors.filter((connector) => connector.id !== "injected");
  return discovered.length > 0 ? discovered : connectors.filter((connector) => connector.id === "injected");
}

function WalletChooser({ connectors, onPick, onClose, busyId }: { connectors: Connector[]; onPick: (connector: Connector) => void; onClose: () => void; busyId: string | null }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-carbon/30" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="wallet-chooser-title" className="relative w-full max-w-sm rounded-2xl border border-fog bg-paper-white p-6 shadow-subtle-3">
        <h2 id="wallet-chooser-title" className="text-subheading font-medium text-carbon">
          Choose a wallet
        </h2>
        <p className="mt-1 text-caption text-graphite">
          Every wallet installed in this browser is listed. The one you pick is remembered on every page until you disconnect.
        </p>
        <ul className="mt-5 flex flex-col gap-2">
          {connectors.map((connector) => (
            <li key={connector.uid}>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => onPick(connector)}
                className="flex w-full items-center gap-3 rounded-xl border border-fog px-4 py-3 text-left text-body text-carbon transition-colors hover:bg-linen disabled:cursor-not-allowed disabled:text-ash"
              >
                {connector.icon ? (
                  <img src={connector.icon} alt="" aria-hidden="true" width={24} height={24} className="size-6 rounded-md" />
                ) : (
                  <span aria-hidden="true" className="size-6 rounded-md bg-mist" />
                )}
                <span className="flex-1">{describeConnector(connector)}</span>
                {busyId === connector.uid ? <span className="text-caption text-ash">Connecting</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-caption text-ash">Square never asks for keys. A wallet only signs the transactions you send from a job page.</p>
      </div>
    </div>
  );
}

export function WalletButton() {
  const [mounted, setMounted] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting, variables, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { notify } = useTx();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (connectError) notify({ status: "error", label: "Wallet connection", message: describeError(connectError) });
  }, [connectError, notify]);

  useEffect(() => {
    if (switchError) notify({ status: "error", label: "Network switch", message: describeError(switchError) });
  }, [switchError, notify]);

  useEffect(() => {
    if (isConnected) setChoosing(false);
  }, [isConnected]);

  const choices = useMemo(() => usableConnectors(connectors), [connectors]);
  const busyId = connecting && variables?.connector && "uid" in variables.connector ? variables.connector.uid : null;

  if (!mounted || !isConnected || !address) {
    return (
      <>
        <button
          type="button"
          className={pill}
          disabled={choices.length === 0 || connecting}
          onClick={() => {
            const only = choices.length === 1 ? choices[0] : undefined;
            if (only) connect({ connector: only });
            else setChoosing(true);
          }}
        >
          {connecting ? "Connecting" : choices.length === 0 && mounted ? "No wallet found" : "Connect wallet"}
        </button>
        {choosing ? (
          <WalletChooser connectors={choices} busyId={busyId} onClose={() => setChoosing(false)} onPick={(connector) => connect({ connector })} />
        ) : null}
      </>
    );
  }

  if (chainId !== activeChain.id) {
    return (
      <button type="button" className={pill} disabled={switching} onClick={() => switchChain({ chainId: activeChain.id })}>
        <ArcNetworkMark className="size-4" />
        {switching ? "Switching" : `Switch to ${activeChain.name}`}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={pill}
      title="Disconnect this wallet"
      aria-label={`Connected as ${address}. Disconnect`}
      onClick={() => disconnect()}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-mint" />
      <span className="tabular-nums">{shortAddress(address)}</span>
    </button>
  );
}
