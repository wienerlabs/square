import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { loginCommand } from "../src/commands/login.js";

/**
 * The commands' surface, driven through commander: which options exist, and
 * what --json puts on stdout. Anything that needs a passphrase or a chain is
 * not here.
 */

async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    await buildProgram().parseAsync(["node", "square", ...args]);
  } finally {
    spy.mockRestore();
  }
  return out.join("");
}

describe("square login", () => {
  it("has no --import-key: a key on the command line is a key in the shell history", () => {
    const longs = loginCommand().options.map((o) => o.long);
    expect(longs).not.toContain("--import-key");
    expect(longs).toContain("--import-file");
    expect(longs).toContain("--json");
  });
});

describe("--json on every command", () => {
  let sandbox: string;
  const ENV_KEYS = ["SQUARE_HOME", "SQUARE_CHAIN_ID", "SQUARE_RPC_URL", "SQUARE_REGISTRY"] as const;
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "square-cmd-test-"));
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SQUARE_HOME = sandbox;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  it("config --json prints the effective configuration as one document", async () => {
    // The README says every command takes --json, and config, the command
    // whose whole output is configured data, was one of three that did not:
    // commander refused the flag and the script exited 1.
    const doc = JSON.parse(await run("config", "--json")) as Record<string, unknown>;
    expect(doc.file).toBe(join(sandbox, "config.json"));
    expect(doc.chainId).toBe(5042002);
    expect(typeof doc.rpcUrl).toBe("string");
    expect(doc.rpcOverrides).toEqual({});
  });

  it("config set-rpc --json prints what is in effect afterwards", async () => {
    const doc = JSON.parse(await run("config", "set-rpc", "5042002", "https://rpc.example", "--json")) as {
      rpcUrl: string;
      rpcOverrides: Record<string, string>;
    };
    expect(doc.rpcUrl).toBe("https://rpc.example");
    expect(doc.rpcOverrides).toEqual({ "5042002": "https://rpc.example" });
  });

  it("logout --json reports what it did, including nothing", async () => {
    const doc = JSON.parse(await run("logout", "--yes", "--json")) as { deleted: boolean; keystore: string };
    expect(doc.deleted).toBe(false);
    expect(doc.keystore).toBe(join(sandbox, "keystore.json"));
  });
});
