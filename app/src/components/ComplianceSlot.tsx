"use client";

import { AddressLink } from "@/components/AddressLink";
import { isZeroAddress } from "@/lib/format";
import { useNetwork } from "@/lib/square";

export function ComplianceSlot() {
  const network = useNetwork();
  const data = network.data;
  if (!data) return null;
  if (isZeroAddress(data.complianceModule)) {
    return (
      <p className="max-w-2xl text-caption text-graphite">
        Read from the deployed hook right now: the compliance slot is open, so no release is proof gated yet. The circuit,
        the prover and the on-chain verifier are live; settlement is not wired to them.
      </p>
    );
  }
  return (
    <p className="max-w-2xl text-caption text-graphite">
      Read from the deployed hook right now: a compliance module is installed at{" "}
      <AddressLink address={data.complianceModule} />, so every release is proof gated.
    </p>
  );
}
