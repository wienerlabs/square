import { describe, it, expect, vi, beforeEach } from "vitest";
import { AipDidResolver } from "../src/resolve.js";
import type { ResolverOptions } from "../src/types.js";

const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const CHAIN = 5042002;
const DID = (id: number | string) => `did:aip:eip155:${CHAIN}:${REGISTRY}:${id}`;
const OWNER = "0x7954350d124ff904f0d4d89cceb4499c852c4628";
const OWNER_CS = "0x7954350d124Ff904F0D4D89CCEB4499C852C4628";

/** Stand in for the chain so behaviour is tested, not connectivity. */
function fakeChain(opts: {
  chainId?: number;
  ownerOf?: (id: bigint) => string;
  tokenURI?: (id: bigint) => string;
  getAgentWallet?: (id: bigint) => string;
  blockNumber?: bigint;
}) {
  return {
    getChainId: vi.fn(async () => opts.chainId ?? CHAIN),
    getBlockNumber: vi.fn(async () => opts.blockNumber ?? 42n),
    readContract: vi.fn(async ({ functionName, args }: any) => {
      const id = args[0] as bigint;
      if (functionName === "ownerOf") {
        if (!opts.ownerOf) throw new Error("reverted");
        return opts.ownerOf(id);
      }
      if (functionName === "tokenURI") {
        if (!opts.tokenURI) throw new Error("reverted");
        return opts.tokenURI(id);
      }
      if (functionName === "getAgentWallet") {
        if (!opts.getAgentWallet) throw new Error("reverted");
        return opts.getAgentWallet(id);
      }
      throw new Error(`unexpected ${functionName}`);
    }),
  };
}

function resolverWith(chain: any, extra: Partial<ResolverOptions> = {}) {
  const r = new AipDidResolver({ rpc: { [CHAIN]: "http://stub" }, ...extra });
  (r as any).clients.set(CHAIN, chain);
  return r;
}

describe("resolve — never throws", () => {
  it("reports a malformed DID instead of throwing", async () => {
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER }));
    const res = await r.resolve("did:aip:nonsense");
    expect(res.didDocument).toBeNull();
    expect(res.didResolutionMetadata.error).toBe("invalidDid");
  });

  it("reports an unconfigured chain", async () => {
    const r = new AipDidResolver({ rpc: {} });
    const res = await r.resolve(DID(2));
    expect(res.didResolutionMetadata.error).toBe("unsupportedChain");
  });

  it("refuses an RPC that reports a different chain id", async () => {
    const r = resolverWith(fakeChain({ chainId: 1, ownerOf: () => OWNER }));
    const res = await r.resolve(DID(2));
    expect(res.didResolutionMetadata.error).toBe("unsupportedChain");
    expect(res.didResolutionMetadata.errorMessage).toMatch(/reports chain id 1/);
  });

  it("reports notFound when ownerOf reverts", async () => {
    const r = resolverWith(fakeChain({}));
    const res = await r.resolve(DID(999999));
    expect(res.didResolutionMetadata.error).toBe("notFound");
  });
});

describe("resolve — the empty agentURI case", () => {
  it("still produces a valid document with no services", async () => {
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER, tokenURI: () => "" }));
    const res = await r.resolve(DID(1));
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocument!.id).toBe(DID(1));
    expect(res.didDocument!.service).toEqual([]);
    expect(res.didDocument!.controller).toBe(`did:pkh:eip155:${CHAIN}:${OWNER_CS}`);
    expect(res.didResolutionMetadata.warnings).toBeUndefined();
    // No file to read is not the same as a file that could not be read.
    expect(res.didDocumentMetadata.registrationFile).toBeUndefined();
  });
});

describe("resolve — an unreachable registration file is a warning", () => {
  it("returns the on-chain document and warns", async () => {
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "ipfs://bafyunreachable" }),
      { fetchAgentUri: async () => { throw new Error("gateway down"); } }
    );
    const res = await r.resolve(DID(2));
    expect(res.didDocument).not.toBeNull();
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didResolutionMetadata.warnings?.[0]?.code).toMatch(/agentUri/);
  });

  it("says in the document metadata that the file was not read", async () => {
    // A deactivated agent whose file cannot be fetched must not come back
    // looking active. `deactivated` stays unset, because nothing was read,
    // and `registrationFile` says so next to it, where a consumer deciding
    // whether to pay the agent is looking.
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "ipfs://bafyunreachable" }),
      { fetchAgentUri: async () => { throw new Error("gateway down"); } }
    );
    const res = await r.resolve(DID(2));
    expect(res.didDocumentMetadata.deactivated).toBeUndefined();
    expect(res.didDocumentMetadata.registrationFile).toBe("unavailable");

    const reverted = resolverWith(fakeChain({ ownerOf: () => OWNER }));
    expect((await reverted.resolve(DID(2))).didDocumentMetadata.registrationFile).toBe("unavailable");
  });

  it("warns when the file is not a JSON object", async () => {
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "https://x/card.json" }),
      { fetchAgentUri: async () => "a string, not a card" }
    );
    const res = await r.resolve(DID(2));
    expect(res.didDocument).not.toBeNull();
    expect(res.didResolutionMetadata.warnings?.[0]?.code).toBe("agentUriMalformed");
    expect(res.didDocumentMetadata.registrationFile).toBe("unavailable");
  });
});

describe("resolve — agent wallet", () => {
  it("adds #agent-wallet even when it equals the owner", async () => {
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "", getAgentWallet: () => OWNER })
    );
    const res = await r.resolve(DID(2));
    const ids = res.didDocument!.verificationMethod.map((v) => v.id);
    expect(ids).toEqual([`${DID(2)}#owner`, `${DID(2)}#agent-wallet`]);
    expect(res.didDocument!.assertionMethod).toHaveLength(2);
    // A payment address is not an authentication key.
    expect(res.didDocument!.authentication).toEqual([`${DID(2)}#owner`]);
  });

  it("omits it when the registry does not expose one", async () => {
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER, tokenURI: () => "" }));
    const res = await r.resolve(DID(2));
    expect(res.didDocument!.verificationMethod).toHaveLength(1);
  });

  it("omits it when it is the zero address", async () => {
    const r = resolverWith(fakeChain({
      ownerOf: () => OWNER, tokenURI: () => "",
      getAgentWallet: () => "0x0000000000000000000000000000000000000000",
    }));
    const res = await r.resolve(DID(2));
    expect(res.didDocument!.verificationMethod).toHaveLength(1);
  });
});

describe("resolve — services", () => {
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Scribe",
    description: "d",
    services: [
      { name: "A2A", endpoint: "https://scribe.example/card.json" },
      { name: "DID", endpoint: DID(2) },
      { name: "A2A", endpoint: "https://backup.example/card.json" },
      { name: "broken" },
      "not an object",
    ],
  };

  it("drops the self-referencing DID entry, de-duplicates ids, skips junk", async () => {
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "https://x/card.json" }),
      { fetchAgentUri: async () => card }
    );
    const res = await r.resolve(DID(2));
    const svc = res.didDocument!.service;
    expect(svc.map((s) => s.id)).toEqual([`${DID(2)}#a2a`, `${DID(2)}#a2a-2`]);
    expect(svc.every((s) => s.serviceEndpoint.startsWith("https://"))).toBe(true);
  });

  it("marks an inactive registration deactivated, and says why", async () => {
    const r = resolverWith(
      fakeChain({ ownerOf: () => OWNER, tokenURI: () => "https://x/card.json" }),
      { fetchAgentUri: async () => ({ ...card, active: false }) }
    );
    const res = await r.resolve(DID(2));
    expect(res.didDocumentMetadata.deactivated).toBe(true);
    expect(res.didDocumentMetadata.deactivationReason).toBe("registrationInactive");
    expect(res.didDocumentMetadata.registrationFile).toBeUndefined();
  });
});

describe("resolve — v1", () => {
  const V1 = "did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:scribe";

  it("reports unsupportedVersion, not invalidDid, without a handler", async () => {
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER }));
    const res = await r.resolve(V1);
    expect(res.didResolutionMetadata.error).toBe("unsupportedVersion");
  });

  it("delegates to an injected v1 resolver and marks it deprecated", async () => {
    const v1Resolver = vi.fn(async () => ({
      didDocument: { id: V1 } as any,
      didResolutionMetadata: { contentType: "application/did+ld+json" as const },
      didDocumentMetadata: {},
    }));
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER }), { v1Resolver });
    const res = await r.resolve(V1);
    expect(v1Resolver).toHaveBeenCalledOnce();
    expect(res.didDocumentMetadata.deprecated).toBe(true);
  });
});

describe("resolve — block pinning", () => {
  it("reads every call at the block it reports as versionId", async () => {
    const chain = fakeChain({ ownerOf: () => OWNER, tokenURI: () => "", blockNumber: 12345n });
    const r = resolverWith(chain);
    const res = await r.resolve(DID(2));
    expect(res.didDocumentMetadata.versionId).toBe("12345");
    // Every readContract must carry that block, or versionId is a guess.
    for (const call of chain.readContract.mock.calls) {
      expect((call[0] as any).blockNumber).toBe(12345n);
    }
  });

  it("does not read unpinned when the block number cannot be had", async () => {
    // The one way the guarantee can fail. Silently falling back to `latest`
    // would let three reads straddle a Transfer and produce a document from
    // no single moment, with no versionId to say so; networkError tells the
    // caller to retry instead, and nothing is read in the meantime.
    const chain = fakeChain({ ownerOf: () => OWNER, tokenURI: () => "" });
    chain.getBlockNumber.mockRejectedValueOnce(new Error("rate limited"));
    const res = await resolverWith(chain).resolve(DID(2));
    expect(res.didDocument).toBeNull();
    expect(res.didResolutionMetadata.error).toBe("networkError");
    expect(res.didResolutionMetadata.errorMessage).toMatch(/pinned/);
    expect(chain.readContract).not.toHaveBeenCalled();
  });
});

describe("resolve — registry allowlist", () => {
  it("refuses a registry outside the allowlist", async () => {
    const r = resolverWith(fakeChain({ ownerOf: () => OWNER }), {
      allowedRegistries: ["0x0000000000000000000000000000000000000001"],
    });
    const res = await r.resolve(DID(2));
    // Not notFound: the agent may exist, we declined to look.
    expect(res.didResolutionMetadata.error).toBe("registryNotAllowed");
    expect(res.didResolutionMetadata.errorMessage).toMatch(/allowlist/);
  });
});
