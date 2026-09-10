import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";
import { ValidationError } from "../src/core/errors.js";

/**
 * The option checks `register` makes before it reads a config file or touches
 * the network. Everything after those needs a chain and is exercised by
 * live.test.ts against Arc Testnet.
 */
async function register(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["node", "square", "register", ...args]);
}

describe("square register: options that contradict each other", () => {
  it("refuses --card-file without --agent-uri", async () => {
    await expect(register("--card-file", "./card.json")).rejects.toThrow(ValidationError);
    await expect(register("--card-file", "./card.json")).rejects.toThrow(/--agent-uri/);
  });

  it("refuses --card-file together with --no-card-check", async () => {
    // --no-card-check used to win silently: the block that reads the card
    // never ran, --card-file was ignored, and the user believed a card had
    // been checked that never was. The first contradiction was already an
    // error; this is the second.
    const args = ["--no-card-check", "--card-file", "./card.json", "--agent-uri", "https://acme.example/agent.json"];
    await expect(register(...args)).rejects.toThrow(ValidationError);
    await expect(register(...args)).rejects.toThrow(/--no-card-check/);
  });
});
