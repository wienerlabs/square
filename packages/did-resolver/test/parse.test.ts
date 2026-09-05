import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseDid, formatDid, InvalidDidError } from "../src/parse.js";

/**
 * Driven by the specification's own conformance vectors. The spec and this
 * package cannot drift: if docs/did-aip/test-vectors.json changes, these fail.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(HERE, "../../../docs/did-aip/test-vectors.json"), "utf8")
) as {
  parse: {
    valid: Array<Record<string, unknown>>;
    rejected: Array<{ did: string; error: string; reason: string }>;
  };
};

describe("spec vectors — accepted", () => {
  for (const v of vectors.parse.valid) {
    it(`${v.did as string} → v${v.version as number}`, () => {
      const p = parseDid(v.did as string);
      expect(p.version).toBe(v.version);
      if (p.version === 2) {
        expect(p.namespace).toBe(v.namespace);
        expect(p.chainId).toBe(v.chainId);
        expect(p.registry).toBe(v.registry);
        expect(p.agentId.toString()).toBe(v.agentId);
        expect(p.agentRegistry).toBe(v.agentRegistry);
      } else {
        expect(p.ownerPubkey).toBe(v.ownerPubkey);
        expect(p.agentId).toBe(v.agentId);
      }
    });
  }
});

describe("spec vectors — rejected", () => {
  for (const v of vectors.parse.rejected) {
    it(`${v.did} — ${v.reason}`, () => {
      expect(() => parseDid(v.did)).toThrow(InvalidDidError);
    });
  }
});

describe("parse", () => {
  it("rejects anything that is not did:aip", () => {
    for (const d of ["", "did:web:example.com", "did:aip", "did:aip:", "not-a-did"]) {
      expect(() => parseDid(d), d).toThrow(InvalidDidError);
    }
  });

  it("says specifically that a checksummed registry is the problem", () => {
    expect(() =>
      parseDid("did:aip:eip155:5042002:0x8004A818BFB912233C491871B3D84C89A494BD9E:2")
    ).toThrow(/lowercase/);
  });

  it("discriminates on segment count, not on the first segment", () => {
    // Three segments is neither version, even though it starts with eip155.
    expect(() => parseDid("did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e"))
      .toThrow(/2 segments|4/);
  });

  it("round-trips through formatDid", () => {
    const did = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2";
    const p = parseDid(did);
    if (p.version !== 2) throw new Error("expected v2");
    expect(formatDid(p.chainId, p.registry, p.agentId)).toBe(did);
  });

  it("keeps agentId exact beyond Number.MAX_SAFE_INTEGER", () => {
    const big = "99999999999999999999999999";
    const p = parseDid(`did:aip:eip155:1:0x8004a818bfb912233c491871b3d84c89a494bd9e:${big}`);
    if (p.version !== 2) throw new Error("expected v2");
    expect(p.agentId.toString()).toBe(big);
  });
});
