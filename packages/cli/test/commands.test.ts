import { describe, it, expect } from "vitest";
import { loginCommand } from "../src/commands/login.js";

/**
 * The commands' surface, driven through commander: which options exist, and
 * what --json puts on stdout. Anything that needs a passphrase or a chain is
 * not here.
 */

describe("square login", () => {
  it("has no --import-key: a key on the command line is a key in the shell history", () => {
    const longs = loginCommand().options.map((o) => o.long);
    expect(longs).not.toContain("--import-key");
    expect(longs).toContain("--import-file");
    expect(longs).toContain("--json");
  });
});
