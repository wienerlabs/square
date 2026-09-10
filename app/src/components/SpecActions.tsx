"use client";

import { useEffect, useState } from "react";
import { GhostButton } from "./GhostButton";

type CopyState = "idle" | "copied" | "failed";

export function SpecActions({ spec, hash }: { spec: string; hash: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(spec);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function download() {
    const blob = new Blob([spec], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = hash.replace(/^0x/, "").slice(0, 8);
    anchor.download = stamp.length > 0 ? `square-spec-${stamp}.json` : "square-spec.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <GhostButton size="sm" onClick={() => void copy()} disabled={spec.length === 0}>
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy spec"}
      </GhostButton>
      <GhostButton size="sm" onClick={download} disabled={spec.length === 0}>
        Download spec
      </GhostButton>
    </>
  );
}
