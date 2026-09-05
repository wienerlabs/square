import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AipDidResolver } from "../src/resolve.js";

/**
 * Against the live Arc testnet. Opt-in with LIVE=1: a unit suite that needs the
 * network is a unit suite that fails on a train.
 *
 * The expectations come from the specification's vectors, so this test also
 * checks that the vectors still describe reality.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(HERE, "../../../docs/did-aip/test-vectors.json"), "utf8")
) as {
  onChain: {
    network: { chainId: number; rpc: string; registry: string };
    agents: Array<{ agentId: string; owner?: string; expect: Record<string, unknown> }>;
  };
};

const { network, agents } = vectors.onChain;
const did = (id: string) => `did:aip:eip155:${network.chainId}:${network.registry}:${id}`;
const resolver = new AipDidResolver({ rpc: { [network.chainId]: network.rpc }, timeoutMs: 20_000 });

describe.skipIf(!process.env.LIVE)("Arc testnet", () => {
  for (const agent of agents) {
    const resolves = agent.expect.resolves === true;

    it(`agentId ${agent.agentId} ${resolves ? "resolves" : "does not resolve"}`, async () => {
      const res = await resolver.resolve(did(agent.agentId));

      if (!resolves) {
        expect(res.didDocument).toBeNull();
        expect(res.didResolutionMetadata.error).toBe(agent.expect.error);
        return;
      }

      expect(res.didResolutionMetadata.error).toBeUndefined();
      expect(res.didDocument!.id).toBe(did(agent.agentId));
      expect(res.didDocumentMetadata.agentRegistry)
        .toBe(`eip155:${network.chainId}:${network.registry}`);
      expect(res.didDocumentMetadata.versionId).toMatch(/^\d+$/);

      if (agent.expect.controller) {
        expect(res.didDocument!.controller).toBe(agent.expect.controller);
      }
      if (Array.isArray(agent.expect.verificationMethodIds)) {
        expect(res.didDocument!.verificationMethod.map((v) => v.id.split("#")[1]))
          .toEqual((agent.expect.verificationMethodIds as string[]).map((f) => f.slice(1)));
      }
      if (agent.expect.serviceCount !== undefined) {
        expect(res.didDocument!.service).toHaveLength(agent.expect.serviceCount as number);
      }
    }, 45_000);
  }

  it("reports unsupportedChain for a chain we have no RPC for", async () => {
    const res = await resolver.resolve(`did:aip:eip155:1:${network.registry}:1`);
    expect(res.didResolutionMetadata.error).toBe("unsupportedChain");
  }, 20_000);
});
