import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPublicClient, http } from "viem";
import { AipDidResolver } from "@squaresdk/did-resolver";
import { ARC_TESTNET_ID, KNOWN_CHAINS } from "../src/core/chains.js";

/**
 * Against the live Arc testnet, opt-in with LIVE=1.
 *
 * Split in two, because the two halves cost different things:
 *
 *   LIVE=1                          — reads and simulations. Free, no key.
 *   LIVE=1 SQUARE_PRIVATE_KEY=0x…  — a real registration. Spends real testnet
 *                                     gas from a funded Arc address.
 *
 * The second is the issue's acceptance criterion, and it drives the built
 * binary rather than the library, because the criterion is about the command.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../dist/index.js");
const arc = KNOWN_CHAINS[ARC_TESTNET_ID]!;
const exec = promisify(execFile);

const live = Boolean(process.env.LIVE);
const funded = live && Boolean(process.env.SQUARE_PRIVATE_KEY);

async function runCli(args: string[], home: string): Promise<{ stdout: string; stderr: string }> {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing. Run 'npm run build' in packages/cli first.`);
  }
  return exec(process.execPath, [CLI, ...args], {
    env: { ...process.env, SQUARE_HOME: home, NO_COLOR: "1" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

describe.skipIf(!live)("Arc testnet — reads", () => {
  it("agrees with the chain about which chain it is", async () => {
    const client = createPublicClient({ transport: http(arc.rpcUrl) });
    expect(await client.getChainId()).toBe(ARC_TESTNET_ID);
  }, 30_000);

  it("resolves a DID for an agent that exists", async () => {
    const resolver = new AipDidResolver({ rpc: { [ARC_TESTNET_ID]: arc.rpcUrl }, timeoutMs: 20_000 });
    const result = await resolver.resolve(
      `did:aip:eip155:${ARC_TESTNET_ID}:${arc.identityRegistry}:2`,
    );
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocument?.id).toContain(":2");
  }, 45_000);

  it("dry-runs a registration against the real registry without a funded key", async () => {
    // Proves the calldata this CLI builds is accepted by the deployed contract:
    // eth_call returns the id it would mint. No key is used to sign anything.
    const home = await mkdtemp(join(tmpdir(), "square-live-"));
    try {
      const { stdout } = await runCli(
        [
          "register",
          "--dry-run",
          "--json",
          "--agent-uri",
          "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei",
          "--no-card-check",
          // No keystore in this sandbox, and none is needed: a simulation is a
          // read. --from is what lets the check run without a key at all.
          "--from",
          "0x7954350d124Ff904F0D4D89CCEB4499C852C4628",
        ],
        home,
      );
      const out = JSON.parse(stdout) as { dryRun: boolean; predictedAgentId: string; predictedDid: string };
      expect(out.dryRun).toBe(true);
      expect(out.predictedAgentId).toMatch(/^\d+$/);
      expect(out.predictedDid).toBe(
        `did:aip:eip155:${ARC_TESTNET_ID}:${arc.identityRegistry}:${out.predictedAgentId}`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!funded)("Arc testnet — acceptance: register, then resolve", () => {
  it("registers a real agent and resolves the DID it derived", async () => {
    const home = await mkdtemp(join(tmpdir(), "square-live-"));
    try {
      const registered = await runCli(
        ["register", "--yes", "--json", "--agent-uri", "https://example.com/agent.json", "--no-card-check"],
        home,
      );
      // One record per line: "sent" before the receipt is waited for, so the
      // hash reaches a machine consumer even if the wait times out, then
      // "registered" with the result.
      const records = registered.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        status: string;
        did?: string;
        agentId?: string;
        owner?: string;
        transactionHash: string;
      });
      expect(records.map((r) => r.status)).toEqual(["sent", "registered"]);
      const [sent, out] = records as [typeof records[number], typeof records[number]];

      expect(out.did).toBe(
        `did:aip:eip155:${ARC_TESTNET_ID}:${arc.identityRegistry}:${out.agentId}`,
      );
      expect(out.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sent.transactionHash).toBe(out.transactionHash);

      const resolved = await runCli(["resolve", out.did!, "--json"], home);
      const doc = JSON.parse(resolved.stdout) as {
        didDocument: { id: string; controller: string } | null;
        didResolutionMetadata: { error?: string };
      };

      expect(doc.didResolutionMetadata.error).toBeUndefined();
      expect(doc.didDocument?.id).toBe(out.did);
      expect(doc.didDocument?.controller.toLowerCase()).toBe(
        `did:pkh:eip155:${ARC_TESTNET_ID}:${out.owner}`.toLowerCase(),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 180_000);
});
