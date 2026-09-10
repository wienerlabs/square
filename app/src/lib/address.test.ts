import { describe, expect, it } from "vitest";
import { readAddressInput } from "./address";

const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("readAddressInput", () => {
  it("accepts the checksummed and the all lowercase spellings", () => {
    expect(readAddressInput(checksummed)).toEqual({ kind: "valid", address: checksummed });
    expect(readAddressInput(checksummed.toLowerCase())).toEqual({ kind: "valid", address: checksummed });
  });

  it("accepts an uppercase 0X prefix, which viem alone rejects", () => {
    expect(readAddressInput(`0X${checksummed.slice(2)}`)).toEqual({ kind: "valid", address: checksummed });
  });

  it("separates a failed EIP-55 checksum from a length or format error, and offers the checksummed form", () => {
    expect(readAddressInput(`0x${checksummed.slice(2).toUpperCase()}`)).toEqual({ kind: "checksum", suggestion: checksummed });
    expect(readAddressInput("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toEqual({ kind: "checksum", suggestion: checksummed });
  });

  it("calls anything that is not 40 hex characters malformed", () => {
    expect(readAddressInput(checksummed.slice(0, -1))).toEqual({ kind: "malformed" });
    expect(readAddressInput(`${checksummed}00`)).toEqual({ kind: "malformed" });
    expect(readAddressInput("not an address")).toEqual({ kind: "malformed" });
  });

  it("reports an empty input as empty rather than as an error", () => {
    expect(readAddressInput("")).toEqual({ kind: "empty" });
    expect(readAddressInput("   ")).toEqual({ kind: "empty" });
  });
});
