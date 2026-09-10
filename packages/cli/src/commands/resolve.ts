import { Command } from "commander";
import { AipDidResolver, type DidResolutionResult } from "@squaresdk/did-resolver";
import { ARC_TESTNET_ID, KNOWN_CHAINS } from "../core/chains.js";
import { loadConfig, rpcMap } from "../core/config.js";
import { ValidationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { resolutionError, serializeResolution } from "../core/resolution.js";
import { c, glyph } from "../core/theme.js";

interface ResolveOpts {
  json?: boolean;
  chainId?: number;
  rpc?: string;
  ipfsGateway?: string;
  timeout?: number;
}

export function resolveCommand(): Command {
  return new Command("resolve")
    .description("Resolve a did:aip identifier to its DID Document")
    .argument("<did>", "did:aip:eip155:<chainId>:<registry>:<agentId>")
    .option("--json", "Print the full DID Resolution Result as JSON")
    .option("--chain-id <n>", "Add an RPC for this chain id (used with --rpc)", (v) => Number(v))
    .option("--rpc <url>", "RPC endpoint to use for --chain-id, or for the DID's own chain")
    .option("--ipfs-gateway <url>", "Gateway for ipfs:// agent URIs")
    .option("--timeout <ms>", "Network timeout in milliseconds", (v) => Number(v))
    .addHelpText(
      "after",
      `
Examples:
  $ square resolve did:aip:eip155:${ARC_TESTNET_ID}:${KNOWN_CHAINS[ARC_TESTNET_ID]!.identityRegistry}:2
  $ square resolve <did> --json | jq .didDocument.service

The document is printed to stdout; everything else goes to stderr, so --json
pipes cleanly. A resolution failure exits non-zero and still prints the result
under --json, since the error is part of the resolution metadata.
`,
    )
    .action(async (did: string, opts: ResolveOpts) => {
      await runResolve(did, opts);
    });
}

async function runResolve(did: string, opts: ResolveOpts): Promise<void> {
  const config = await loadConfig();
  const rpc = rpcMap(config);

  if (opts.rpc) {
    // Without --chain-id we cannot tell which chain the endpoint speaks for, and
    // silently attaching it to the wrong one would resolve the DID against the
    // wrong chain's registry.
    const chainId = opts.chainId ?? chainIdFromDid(did);
    if (chainId === null) {
      throw new ValidationError(
        "--rpc needs a chain to apply to",
        "Pass --chain-id <n>, or use a v2 DID that names its own chain.",
      );
    }
    rpc[chainId] = opts.rpc;
  }

  const resolver = new AipDidResolver({
    rpc,
    timeoutMs: opts.timeout ?? config.timeoutMs,
    ...(opts.ipfsGateway !== undefined ? { ipfsGateway: opts.ipfsGateway } : {}),
  });

  const result = await resolver.resolve(did);

  if (opts.json) log.out(serializeResolution(result));

  const error = result.didResolutionMetadata.error;
  if (error) {
    throw resolutionError(error, result.didResolutionMetadata.errorMessage ?? error);
  }

  if (!opts.json) render(result);
}

/** The chain id a v2 DID names, or null for anything else. */
function chainIdFromDid(did: string): number | null {
  const seg = did.split(":");
  // did : aip : eip155 : <chainId> : <registry> : <agentId>
  if (seg.length !== 6 || seg[0] !== "did" || seg[1] !== "aip" || seg[2] !== "eip155") return null;
  const n = Number(seg[3]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function render(result: DidResolutionResult): void {
  const doc = result.didDocument;
  if (!doc) return;
  const meta = result.didDocumentMetadata;

  log.blank();
  log.raw(`  ${c.green(glyph.ok)} ${c.bold(doc.id)}`);
  log.blank();
  log.field("controller", doc.controller);
  if (meta.agentRegistry) log.field("registry", meta.agentRegistry);
  if (meta.versionId) log.field("block", meta.versionId);
  if (meta.deactivated) {
    log.field("deactivated", c.yellow(`yes (${meta.deactivationReason ?? "unknown reason"})`));
  } else if (meta.registrationFile === "unavailable") {
    log.field("deactivated", c.yellow("unknown (the registration file could not be read)"));
  }

  log.blank();
  log.raw(`  ${c.dim("verification methods")}`);
  for (const vm of doc.verificationMethod) {
    const fragment = vm.id.slice(vm.id.indexOf("#"));
    const roles = [
      doc.authentication.includes(vm.id) ? "auth" : null,
      doc.capabilityInvocation.includes(vm.id) ? "invoke" : null,
      doc.assertionMethod.includes(vm.id) ? "assert" : null,
    ].filter((r): r is string => r !== null);
    log.field(fragment, `${vm.blockchainAccountId}  ${c.dim(roles.join(" "))}`);
  }

  log.blank();
  if (doc.service.length === 0) {
    log.raw(`  ${c.dim("services")}      ${c.dim("(none)")}`);
  } else {
    log.raw(`  ${c.dim("services")}`);
    for (const s of doc.service) {
      log.field(s.type, s.serviceEndpoint);
    }
  }

  const warnings = result.didResolutionMetadata.warnings ?? [];
  if (warnings.length > 0) {
    log.blank();
    for (const w of warnings) log.warn(`${w.code}: ${w.message}`);
  }
  log.blank();
}
