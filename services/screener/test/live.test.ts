import { describe, expect, it } from "vitest";
import { keccak256, recoverTypedDataAddress, stringToHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SCREENING_DOMAIN_NAME, SCREENING_DOMAIN_VERSION, SCREENING_TYPES, ScreeningRefused, TrmSanctionsSource, screenAndSign } from "../src/index.js";

// Against TRM's real API, keyless: 100 requests a day, so this file makes two.
// Both addresses below are on OFAC's SDN list under Lazarus Group, from the Ronin
// bridge theft, and TRM flagged both when this was written; the test would say
// if either stopped being flagged.
const CANARY: Address = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const DESIGNATED: Address = "0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073";

describe.skipIf(!process.env["LIVE"])("screening against TRM's sanctions API", () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const domain = { chainId: 5042002, registry: privateKeyToAccount(generatePrivateKey()).address };

  it("flags a designated address, clears an address nobody has used, and signs both", async () => {
    const unused = privateKeyToAccount(generatePrivateKey()).address;
    const { screenings, rawBody, sourceMs } = await screenAndSign({ source: new TrmSanctionsSource(), canary: CANARY, signer, domain }, [DESIGNATED, unused]);
    expect(sourceMs).toBeGreaterThan(0);
    expect(screenings.map((s) => [s.screening.subject, s.screening.sanctioned])).toEqual([
      [DESIGNATED, true],
      [unused, false],
    ]);
    for (const { screening, signature } of screenings) {
      expect(screening.evidence).toBe(keccak256(stringToHex(rawBody)));
      const recovered = await recoverTypedDataAddress({
        domain: { name: SCREENING_DOMAIN_NAME, version: SCREENING_DOMAIN_VERSION, chainId: domain.chainId, verifyingContract: domain.registry },
        types: SCREENING_TYPES,
        primaryType: "Screening",
        message: screening,
        signature,
      });
      expect(recovered).toBe(signer.address);
    }
  });

  // The guard against covenant's empty list, with no mock: a canary the real
  // source does not flag stands in for a source that flags nothing, and the
  // screener refuses to sign anything it said.
  it("signs nothing when the source does not flag the canary", async () => {
    const notDesignated = privateKeyToAccount(generatePrivateKey()).address;
    const attempt = screenAndSign({ source: new TrmSanctionsSource(), canary: notDesignated, signer, domain }, [DESIGNATED]);
    await expect(attempt).rejects.toBeInstanceOf(ScreeningRefused);
    await expect(attempt).rejects.toMatchObject({ status: 503, message: expect.stringContaining("did not flag the canary") });
  });
});
