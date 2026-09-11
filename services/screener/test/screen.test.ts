import { describe, expect, it } from "vitest";
import { hexToString, recoverTypedDataAddress, stringToHex, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MAX_SUBJECTS,
  SCREENING_DOMAIN_NAME,
  SCREENING_DOMAIN_VERSION,
  SCREENING_TYPES,
  ScreeningRefused,
  TRM_SOURCE_ID,
  TrmSanctionsSource,
  screenAndSign,
  signScreening,
} from "../src/index.js";

const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;

// Every refusal here happens before the source is asked, which is the property
// under test: a malformed request costs nothing and attests nothing. The source
// is the real one, and none of these requests reaches it.
describe("a request is refused before the source is asked", () => {
  const options = {
    source: new TrmSanctionsSource(),
    canary: fresh(),
    signer: privateKeyToAccount(generatePrivateKey()),
    domain: { chainId: 5042002, registry: fresh() },
  };

  it.each([
    ["no addresses", []],
    ["too many", Array.from({ length: MAX_SUBJECTS + 1 }, fresh)],
    ["something that is not an address", ["0x1234"]],
    ["the zero address", [zeroAddress]],
  ])("%s", async (_, input) => {
    await expect(screenAndSign(options, input)).rejects.toMatchObject({ name: "ScreeningRefused", status: 400 });
  });

  it("the same address twice, in any case", async () => {
    const a = fresh();
    await expect(screenAndSign(options, [a, a.toLowerCase()])).rejects.toBeInstanceOf(ScreeningRefused);
  });

  it("the canary as a subject", async () => {
    await expect(screenAndSign(options, [options.canary])).rejects.toThrow(/canary is not a subject/);
  });
});

describe("what the screener signs", () => {
  it("recovers to the screener under the registry's domain", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const domain = { chainId: 5042002, registry: fresh() };
    const screening = {
      subject: fresh(),
      sanctioned: false,
      screenedAt: 1_788_356_730n,
      source: stringToHex(TRM_SOURCE_ID, { size: 32 }),
      evidence: stringToHex("evidence", { size: 32 }),
    };
    const signature = await signScreening(signer, domain, screening);
    const recovered = await recoverTypedDataAddress({
      domain: { name: SCREENING_DOMAIN_NAME, version: SCREENING_DOMAIN_VERSION, chainId: domain.chainId, verifyingContract: domain.registry },
      types: SCREENING_TYPES,
      primaryType: "Screening",
      message: screening,
      signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("names its source in a bytes32 that reads back as the id", () => {
    expect(hexToString(stringToHex(TRM_SOURCE_ID, { size: 32 }), { size: 32 })).toBe(TRM_SOURCE_ID);
  });
});
