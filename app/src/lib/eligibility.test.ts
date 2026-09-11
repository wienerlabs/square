import { approveBuyers, drawBuyerSalt } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ELIGIBILITY_FORMAT_MESSAGE, readEligibilityInput } from "./eligibility";

const address = () => privateKeyToAccount(generatePrivateKey()).address;

describe("readEligibilityInput", () => {
  it("reads back an entry exactly as the SDK issues it", () => {
    const [mine, ...others] = [address(), address(), address()];
    const entry = approveBuyers([mine!, ...others]).eligibilityOf(mine!);
    expect(entry.proof.length).toBeGreaterThan(0);
    expect(readEligibilityInput(JSON.stringify(entry))).toEqual({ kind: "valid", eligibility: entry, buyer: undefined });
  });

  it("accepts the empty proof of a list of one", () => {
    const mine = address();
    const entry = approveBuyers([mine]).eligibilityOf(mine);
    expect(entry.proof).toEqual([]);
    expect(readEligibilityInput(JSON.stringify(entry))).toEqual({ kind: "valid", eligibility: entry, buyer: undefined });
  });

  it("returns the buyer the entry names, checksummed, so it can be held against the connected account", () => {
    const mine = address();
    const entry = approveBuyers([mine, address()]).eligibilityOf(mine);
    const pasted = JSON.stringify({ buyer: mine.toLowerCase(), ...entry });
    expect(readEligibilityInput(pasted)).toEqual({ kind: "valid", eligibility: entry, buyer: mine });
  });

  it("reports an empty input as empty rather than as an error", () => {
    expect(readEligibilityInput("")).toEqual({ kind: "empty" });
    expect(readEligibilityInput("  \n ")).toEqual({ kind: "empty" });
  });

  it("names what is wrong with anything else", () => {
    const salt = drawBuyerSalt();
    const cases: Array<[string, RegExp | string]> = [
      ["not json", ELIGIBILITY_FORMAT_MESSAGE],
      [JSON.stringify([salt]), ELIGIBILITY_FORMAT_MESSAGE],
      [JSON.stringify({ proof: [] }), /salt/],
      [JSON.stringify({ salt: salt.slice(0, -2), proof: [] }), /salt/],
      [JSON.stringify({ salt: salt.slice(0, -1), proof: [] }), /salt/],
      [JSON.stringify({ salt, proof: salt }), /proof/],
      [JSON.stringify({ salt, proof: [salt.slice(0, -2)] }), /proof/],
      [JSON.stringify({ salt, proof: [], buyer: "0x1234" }), /buyer/],
    ];
    for (const [input, message] of cases) {
      const read = readEligibilityInput(input);
      expect(read.kind, input).toBe("malformed");
      if (read.kind === "malformed") expect(read.message).toMatch(message);
    }
  });
});
