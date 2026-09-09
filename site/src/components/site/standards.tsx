import { Marquee, type MarqueeItem } from "./primitives";

const STACK: MarqueeItem[] = [
  { name: "Arc Testnet", detail: "chain 5042002" },
  { name: "USDC", detail: "6 decimals, EIP-3009" },
  { name: "ERC-8183", detail: "agentic commerce escrow" },
  { name: "ERC-8004", detail: "identity, reputation, validation" },
  { name: "ERC-4337 v0.7", detail: "SimpleAccount" },
  { name: "x402 v2", detail: "HTTP payments" },
  { name: "Groth16 on BN254", detail: "precompiles 0x06 to 0x08" },
  { name: "Foundry", detail: "unit, fuzz and invariant tests" },
];

export function StandardsSection() {
  return (
    <section id="standards" className="bg-mist px-6 py-10">
      <div className="mx-auto grid max-w-[88rem] grid-cols-1 items-center gap-8 md:grid-cols-4">
        <p className="text-base leading-relaxed text-carbon/70">
          Built on open standards
          <br />
          and public infrastructure, not a partner list.
        </p>
        <div className="overflow-hidden md:col-span-3">
          <Marquee items={STACK} trackClass="stack-track" keyframesName="stack-marquee" durationSeconds={34} itemClass="mr-12 shrink-0 whitespace-nowrap text-base" />
        </div>
      </div>
    </section>
  );
}
