import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createPublicClient, http } from "viem";

/**
 * The Phase 1 end-to-end check, against the agents permanently registered on
 * Arc Testnet (docs/smoke/agents.json).
 *
 * It reads and never writes, so it needs no key and spends no gas, and it can
 * run on every pull request. Registration is not re-exercised here because the
 * agents it reads are what registration produced; the write path has its own
 * opt-in test in live.test.ts.
 *
 * Gated on SMOKE=1 so `npm test` stays hermetic. CI sets it in a separate job,
 * where a network flake is visibly not a unit-test failure.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../dist/index.js");
const DOCS = join(HERE, "../../../docs");
const exec = promisify(execFile);

interface SmokeAgent {
  label: string;
  agentId: string;
  did: string;
  cardFile?: string;
  agentUriScheme: string;
  expect: { serviceCount: number; serviceTypes: string[]; warnings: number };
}

const fixture = JSON.parse(readFileSync(join(DOCS, "smoke/agents.json"), "utf8")) as {
  network: { chainId: number; rpc: string; identityRegistry: `0x${string}` };
  owner: string;
  agents: SmokeAgent[];
  absent: { did: string };
};

const REGISTRY_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

interface ResolutionResult {
  didDocument: {
    id: string;
    controller: string;
    verificationMethod: Array<{ id: string; blockchainAccountId: string }>;
    service: Array<{ id: string; type: string; serviceEndpoint: string }>;
  } | null;
  didResolutionMetadata: { error?: string; warnings?: Array<{ code: string }> };
  didDocumentMetadata: { versionId?: string; agentRegistry?: string; deactivated?: boolean };
}

async function resolveViaCli(did: string): Promise<{ result: ResolutionResult; code: number }> {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing. Run 'npm run build' in packages/cli first.`);
  }
  const home = await mkdtemp(join(tmpdir(), "square-smoke-"));
  try {
    // A resolution failure is an expected outcome here, not a test error: the
    // CLI exits non-zero and still prints the result, so the rejection is
    // caught and read rather than thrown.
    const child = await exec(process.execPath, [CLI, "resolve", did, "--json"], {
      env: { ...process.env, SQUARE_HOME: home, NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
    }).catch((err: { stdout?: string; stderr?: string; code?: number }) => err);

    const stdout = (child as { stdout?: string }).stdout ?? "";
    // execFile resolves with no `code` on success; a rejection carries it.
    const code = (child as { code?: number }).code ?? 0;

    let result: ResolutionResult;
    try {
      result = JSON.parse(stdout) as ResolutionResult;
    } catch {
      // Without this the failure surfaces as "Unexpected end of JSON input",
      // which says nothing about the command that produced no JSON.
      const stderr = ((child as { stderr?: string }).stderr ?? "").trim();
      throw new Error(
        `square resolve ${did} exited ${code} without JSON on stdout.` +
          (stderr ? `\nstderr: ${stderr.slice(0, 800)}` : ""),
      );
    }
    return { result, code };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The canonical data: URI for a card, byte for byte as `square register` builds it. */
function dataUriFor(card: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
}

describe.skipIf(!process.env.SMOKE)("Phase 1 end to end, on Arc Testnet", () => {
  it("the committed card still validates against the published schema", () => {
    const schema = JSON.parse(readFileSync(join(DOCS, "agent-card/schema.json"), "utf8"));
    const card = JSON.parse(readFileSync(join(DOCS, "smoke/agent-card.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(card), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("the card on chain is byte for byte the card in the repository", async () => {
    // Without this, docs/smoke/agent-card.json could drift from what was
    // actually registered and every other assertion here would still pass.
    const agent = fixture.agents.find((a) => a.cardFile)!;
    const card = JSON.parse(readFileSync(join(DOCS, "smoke", agent.cardFile!), "utf8"));

    const client = createPublicClient({ transport: http(fixture.network.rpc) });
    const onChain = (await client.readContract({
      address: fixture.network.identityRegistry,
      abi: REGISTRY_ABI,
      functionName: "tokenURI",
      args: [BigInt(agent.agentId)],
    })) as string;

    expect(onChain).toBe(dataUriFor(card));
  }, 45_000);

  for (const agent of fixture.agents) {
    it(`resolves the ${agent.label} agent`, async () => {
      const { result } = await resolveViaCli(agent.did);

      expect(result.didResolutionMetadata.error).toBeUndefined();
      expect(result.didDocument).not.toBeNull();
      expect(result.didDocument!.id).toBe(agent.did);
      expect(result.didDocument!.controller.toLowerCase()).toBe(
        `did:pkh:eip155:${fixture.network.chainId}:${fixture.owner}`.toLowerCase(),
      );

      // Both verification methods are always present: getAgentWallet is not
      // exposed by this deployment, so #agent-wallet falls back to the owner.
      // Method spec section 4.4 keys on the address being non-zero, not on it
      // differing from the owner.
      expect(result.didDocument!.verificationMethod.map((v) => v.id.split("#")[1])).toEqual([
        "owner",
        "agent-wallet",
      ]);

      expect(result.didDocument!.service).toHaveLength(agent.expect.serviceCount);
      expect(result.didDocument!.service.map((s) => s.type)).toEqual(agent.expect.serviceTypes);

      // A data: URI is dereferenced without leaving the process, so a card that
      // resolves with warnings means the embedding broke.
      expect(result.didResolutionMetadata.warnings ?? []).toHaveLength(agent.expect.warnings);

      expect(result.didDocumentMetadata.agentRegistry).toBe(
        `eip155:${fixture.network.chainId}:${fixture.network.identityRegistry}`,
      );
      expect(result.didDocumentMetadata.versionId).toMatch(/^\d+$/);
      expect(result.didDocumentMetadata.deactivated).toBeUndefined();
    }, 60_000);
  }

  it("reports an agent that does not exist as notFound, not as a bad identifier", async () => {
    const { result, code } = await resolveViaCli(fixture.absent.did);
    expect(result.didResolutionMetadata.error).toBe("notFound");
    expect(code).toBe(70);
  }, 45_000);
});
