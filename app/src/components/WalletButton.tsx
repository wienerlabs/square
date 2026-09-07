"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { shortAddress } from "@/lib/format";
import { describeError, useTx } from "@/lib/tx";
import { activeChain } from "@/lib/wagmi";

const pill =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-iris px-4 text-caption font-medium text-carbon transition-colors hover:bg-iris/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lavender disabled:cursor-not-allowed disabled:bg-mist disabled:text-ash";

export function WalletButton() {
  const [mounted, setMounted] = useState(false);
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
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

  const connector = connectors[0];

  if (!mounted || !isConnected || !address) {
    return (
      <button
        type="button"
        className={pill}
        disabled={!connector || connecting}
        onClick={() => {
          if (connector) connect({ connector });
        }}
      >
        {connecting ? "Connecting" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== activeChain.id) {
    return (
      <button type="button" className={pill} disabled={switching} onClick={() => switchChain({ chainId: activeChain.id })}>
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
