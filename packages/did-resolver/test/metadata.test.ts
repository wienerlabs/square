import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from "viem";
import { AipDidResolver, MAX_CROSS_REGISTRATION_CHECKS } from "../src/resolve.js";
import { formatDid, parseDid } from "../src/parse.js";
import { IDENTITY_REGISTRY_ABI } from "../src/registry.js";
import type { ResolverOptions } from "../src/types.js";

/**
 * The spec's metadata vectors (docs/did-aip/test-vectors.json, `metadata`)
 * against a stub chain: §10.3's scheme and §8's cross-registrations, the two
 * SHOULDs the resolver did not implement before #152. The vectors carry the
 * registration files inline, served to the stub as data: agentURIs that the
 * default fetcher decodes in-process, so a vector needs no network and the
 * spec and the resolver still cannot drift on these fields.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(HERE, "../../../docs/did-aip/test-vectors.json"), "utf8")) as {
  metadata: {
    agentUriScheme: { cases: Array<{ tokenURI: string; expect: string | null; $comment?: string }> };
    crossRegistrations: {
      rpc: number[];
      registry: string;
      cases: Array<{
        $comment: string;
        did: string;
        file: unknown;
        counterparts: Record<string, unknown>;
        expect: { crossRegistrations: { verified: string[]; unverified: string[] } | null; warnings: string[] };
      }>;
    };
  };
};

const OWNER = "0x7954350d124ff904f0d4d89cceb4499c852c4628";

const dataUri = (file: unknown): string => `data:application/json,${encodeURIComponent(JSON.stringify(file))}`;

function revert(functionName: "ownerOf" | "tokenURI" | "getAgentWallet", registry: string): Error {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: IDENTITY_REGISTRY_ABI, functionName, message: "execution reverted" }) as never,
    { abi: IDENTITY_REGISTRY_ABI, functionName, args: [1n], contractAddress: registry as `0x${string}` },
  );
}

/** One registry on one chain, answering tokenURI per agent id and ownerOf for everyone. */
function fakeChain(chainId: number, registry: string, tokenURI: (id: bigint) => string) {
  return {
    getChainId: vi.fn(async () => chainId),
    getBlockNumber: vi.fn(async () => 42n),
    readContract: vi.fn(async ({ functionName, args }: any) => {
      const id = args[0] as bigint;
      if (functionName === "ownerOf") return OWNER;
      if (functionName === "tokenURI") return tokenURI(id);
      throw revert("getAgentWallet", registry);
    }),
  };
}

function resolverOn(chains: Record<number, ReturnType<typeof fakeChain>>, extra: Partial<ResolverOptions> = {}) {
  const rpc = Object.fromEntries(Object.keys(chains).map((id) => [id, "http://stub"]));
  const r = new AipDidResolver({ rpc, ...extra });
  for (const [id, chain] of Object.entries(chains)) (r as any).clients.set(Number(id), chain);
  return r;
}

describe("vectors — agentUriScheme (§10.3)", () => {
  for (const c of vectors.metadata.agentUriScheme.cases) {
    it(`${JSON.stringify(c.tokenURI)} → ${c.expect === null ? "absent" : c.expect}`, async () => {
      const registry = vectors.metadata.crossRegistrations.registry;
      const chain = fakeChain(5042002, registry, () => c.tokenURI);
      // Whatever the file says is beside the point here; the scheme is what the chain said.
      const r = resolverOn({ 5042002: chain }, { fetchAgentUri: async () => ({}) });
      const res = await r.resolve(formatDid(5042002, registry, 2));
      expect(res.didResolutionMetadata.error).toBeUndefined();
      expect(res.didDocumentMetadata.agentUriScheme).toBe(c.expect === null ? undefined : c.expect);
    });
  }

  it("is reported when the file behind it could not be read", async () => {
    const registry = vectors.metadata.crossRegistrations.registry;
    const chain = fakeChain(5042002, registry, () => "https://down.example/agent.json");
    const r = resolverOn({ 5042002: chain }, {
      fetchAgentUri: async () => {
        throw new Error("gateway down");
      },
    });
    const res = await r.resolve(formatDid(5042002, registry, 2));
    expect(res.didDocumentMetadata.registrationFile).toBe("unavailable");
    expect(res.didDocumentMetadata.agentUriScheme).toBe("https");
  });
});

describe("vectors — crossRegistrations (§8)", () => {
  const { rpc, registry, cases } = vectors.metadata.crossRegistrations;

  /** The stub chains a vector describes: `did`'s own file, and each counterpart's, by agent id. */
  function chainsFor(c: (typeof cases)[number]) {
    const chains: Record<number, ReturnType<typeof fakeChain>> = {};
    for (const chainId of rpc) {
      chains[chainId] = fakeChain(chainId, registry, (id) => {
        const did = formatDid(chainId, registry, id);
        if (did === c.did) return dataUri(c.file);
        if (!(did in c.counterparts)) throw revert("tokenURI", registry);
        const counterpart = c.counterparts[did];
        return counterpart === "" ? "" : dataUri(counterpart);
      });
    }
    return chains;
  }

  for (const c of cases) {
    it(c.$comment, async () => {
      const chains = chainsFor(c);
      const res = await resolverOn(chains).resolve(c.did);
      expect(res.didResolutionMetadata.error).toBeUndefined();
      expect(res.didDocumentMetadata.crossRegistrations).toEqual(
        c.expect.crossRegistrations === null ? undefined : c.expect.crossRegistrations,
      );
      expect((res.didResolutionMetadata.warnings ?? []).map((w) => w.code)).toEqual(c.expect.warnings);
      // Nothing claimed reaches the document: the claims are metadata, the document is the chain's.
      expect(res.didDocument!.service).toEqual([]);
    });
  }

  const self = formatDid(5042002, registry, 2);
  const counterpart = formatDid(1, registry, 22);
  const listsBack = { registrations: [{ agentId: 2, agentRegistry: `eip155:5042002:${registry}` }] };
  const claims = (dids: string[]) => ({
    registrations: dids.map((d) => {
      const p = parseDid(d);
      if (p.version !== 2) throw new Error(d);
      return { agentId: Number(p.agentId), agentRegistry: p.agentRegistry };
    }),
  });

  it("a verified claim is still only metadata: the counterpart is not resolved and its own claims are not followed", async () => {
    // The counterpart's file claims a third agent, which does not exist. If
    // the check recursed it would read tokenURI for id 3; it must read only
    // 22, the counterpart itself.
    const third = formatDid(1, registry, 3);
    const chains = {
      5042002: fakeChain(5042002, registry, () => dataUri(claims([counterpart]))),
      1: fakeChain(1, registry, (id) => {
        if (id === 22n) return dataUri({ registrations: [...listsBack.registrations, ...claims([third]).registrations] });
        throw revert("tokenURI", registry);
      }),
    };
    const res = await resolverOn(chains).resolve(self);
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({ verified: [counterpart], unverified: [] });
    expect(chains[1].readContract.mock.calls.map((call) => (call[0] as any).args[0])).toEqual([22n]);
  });

  it("a counterpart on the chain being resolved is read at the block the document was read at", async () => {
    const other = formatDid(5042002, registry, 9);
    const chain = fakeChain(5042002, registry, (id) => {
      if (id === 2n) return dataUri(claims([other]));
      if (id === 9n) return dataUri(listsBack);
      throw revert("tokenURI", registry);
    });
    chain.getBlockNumber.mockResolvedValue(777n);
    const res = await resolverOn({ 5042002: chain }).resolve(self);
    expect(res.didDocumentMetadata.versionId).toBe("777");
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({ verified: [other], unverified: [] });
    for (const call of chain.readContract.mock.calls) expect((call[0] as any).blockNumber).toBe(777n);
  });

  it("a counterpart on another chain is not pinned to this chain's block", async () => {
    const chains = chainsFor(cases[0]!);
    await resolverOn(chains).resolve(cases[0]!.did);
    for (const call of chains[1]!.readContract.mock.calls) expect((call[0] as any).blockNumber).toBeUndefined();
  });

  it("an endpoint answering with another chain id makes the claim unverified, not the resolution wrong", async () => {
    const chains = chainsFor(cases[0]!);
    chains[1]!.getChainId.mockResolvedValue(10);
    const res = await resolverOn(chains).resolve(cases[0]!.did);
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({ verified: [], unverified: [counterpart] });
  });

  it("a registry outside the allowlist is not read for a counterpart either", async () => {
    const chains = chainsFor(cases[0]!);
    const res = await resolverOn(chains, { allowedRegistries: [registry] }).resolve(cases[0]!.did);
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({ verified: [counterpart], unverified: [] });

    const elsewhere = "0x000000000000000000000000000000000000dead";
    const claimingElsewhere = fakeChain(5042002, registry, () =>
      dataUri({ registrations: [{ agentId: 22, agentRegistry: `eip155:1:${elsewhere}` }] }),
    );
    const other = fakeChain(1, elsewhere, () => dataUri(listsBack));
    const refused = await resolverOn({ 5042002: claimingElsewhere, 1: other }, { allowedRegistries: [registry] }).resolve(self);
    expect(refused.didDocumentMetadata.crossRegistrations).toEqual({
      verified: [],
      unverified: [formatDid(1, elsewhere, 22)],
    });
    expect(other.readContract).not.toHaveBeenCalled();
  });

  it("a transport failure on the counterpart is unverified, and the cause goes to the operator, not the result", async () => {
    const secret = "http://127.0.0.1:1/v2/SUPER-SECRET-KEY";
    const chains = chainsFor(cases[0]!);
    chains[1]!.readContract.mockRejectedValueOnce(
      new ContractFunctionExecutionError(new HttpRequestError({ url: secret, status: 429 }) as never, {
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "tokenURI",
        args: [22n],
        contractAddress: registry as `0x${string}`,
      }),
    );
    const onNetworkError = vi.fn();
    const res = await resolverOn(chains, { onNetworkError }).resolve(cases[0]!.did);
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({ verified: [], unverified: [counterpart] });
    expect(JSON.stringify(res)).not.toContain("SUPER-SECRET");
    expect(onNetworkError).toHaveBeenCalledTimes(1);
    expect(onNetworkError.mock.calls[0]![0]).toContain(counterpart);
  });

  it(`checks at most ${MAX_CROSS_REGISTRATION_CHECKS} claims, reports the rest unverified and says so`, async () => {
    const many = Array.from({ length: MAX_CROSS_REGISTRATION_CHECKS + 3 }, (_, i) => formatDid(1, registry, 100 + i));
    const chains = {
      5042002: fakeChain(5042002, registry, () => dataUri(claims(many))),
      1: fakeChain(1, registry, () => dataUri(listsBack)),
    };
    const res = await resolverOn(chains).resolve(self);
    expect(res.didDocumentMetadata.crossRegistrations).toEqual({
      verified: many.slice(0, MAX_CROSS_REGISTRATION_CHECKS),
      unverified: many.slice(MAX_CROSS_REGISTRATION_CHECKS),
    });
    expect(res.didResolutionMetadata.warnings?.map((w) => w.code)).toEqual(["crossRegistrationsUnchecked"]);
    expect(chains[1].readContract).toHaveBeenCalledTimes(MAX_CROSS_REGISTRATION_CHECKS);
  });
});
