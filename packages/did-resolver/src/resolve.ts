import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  type PublicClient,
} from "viem";
import { buildDidDocument, type RegistrationFile } from "./document.js";
import { AgentUriError, defaultFetchAgentUri } from "./fetch.js";
import { InvalidDidError, parseDid } from "./parse.js";
import { IDENTITY_REGISTRY_ABI } from "./registry.js";
import type {
  DidResolutionResult,
  ParsedV2,
  ResolutionErrorCode,
  ResolutionWarning,
  ResolverOptions,
} from "./types.js";

/** The contract answered, and the answer was a revert or empty data: the chain's own "no". */
function chainSaidNo(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
}

function failure(
  error: ResolutionErrorCode,
  errorMessage: string,
  warnings: ResolutionWarning[] = []
): DidResolutionResult {
  return {
    didDocument: null,
    didResolutionMetadata: { error, errorMessage, ...(warnings.length ? { warnings } : {}) },
    didDocumentMetadata: {},
  };
}

export class AipDidResolver {
  private readonly clients = new Map<number, PublicClient>();

  constructor(private readonly options: ResolverOptions) {}

  /**
   * A chain read failed. The result that goes back to the caller says which
   * read; the cause, which names the endpoint, goes to the operator instead.
   * `fetch.ts` keeps the same rule for the registration file, and for the same
   * reason: the result is public and the URL is not (#267).
   */
  private networkFailure(context: string, cause: unknown): DidResolutionResult {
    this.options.onNetworkError?.(context, cause);
    return failure("networkError", context);
  }

  private client(chainId: number): PublicClient | null {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const url = this.options.rpc[chainId];
    if (!url) return null;
    const c = createPublicClient({ transport: http(url) }) as PublicClient;
    this.clients.set(chainId, c);
    return c;
  }

  /**
   * Resolve a did:aip identifier.
   *
   * Never throws. Every failure is reported in didResolutionMetadata.error —
   * callers embed resolution in agent-to-agent dispatch, where an exception
   * takes down the caller rather than just the lookup.
   */
  async resolve(did: string): Promise<DidResolutionResult> {
    let parsed;
    try {
      parsed = parseDid(did);
    } catch (err) {
      const msg = err instanceof InvalidDidError ? err.message : String(err);
      return failure("invalidDid", msg);
    }

    if (parsed.version === 1) {
      const v1 = this.options.v1Resolver;
      if (!v1) {
        // Well-formed, just not ours. `invalidDid` would tell the caller the
        // identifier is broken, which it is not, and stop them trying another
        // resolver (spec §9.2).
        return failure(
          "unsupportedVersion",
          "did:aip v1 (Solana) is well-formed but this resolver reads ERC-8004 only. " +
            "Supply options.v1Resolver to handle it."
        );
      }
      try {
        const result = await v1(parsed);
        result.didDocumentMetadata.deprecated = true;
        return result;
      } catch (err) {
        return this.networkFailure("v1 resolver threw", err);
      }
    }

    return this.resolveV2(parsed);
  }

  private async resolveV2(parsed: ParsedV2): Promise<DidResolutionResult> {
    const warnings: ResolutionWarning[] = [];

    const allow = this.options.allowedRegistries;
    if (allow && !allow.some((a) => a.toLowerCase() === parsed.registry)) {
      return failure(
        "registryNotAllowed",
        `registry ${parsed.registry} is not in this resolver's allowlist`
      );
    }

    const client = this.client(parsed.chainId);
    if (!client) {
      return failure("unsupportedChain", `no RPC configured for chain id ${parsed.chainId}`);
    }

    // Guard against a misconfigured endpoint: a wrong RPC would return a valid
    // document for a different agent under a correct-looking DID (spec §10.4).
    try {
      const actual = await client.getChainId();
      if (actual !== parsed.chainId) {
        return failure(
          "unsupportedChain",
          `RPC for chain ${parsed.chainId} reports chain id ${actual}`
        );
      }
    } catch (err) {
      return this.networkFailure("chain id check failed", err);
    }

    // Pin every read to one block. didDocumentMetadata.versionId claims to be
    // the block the state was read at, and reading the number afterwards would
    // make that a guess — a block can land between the reads and the report.
    //
    // Without the number there is no pin, and that is a failure, not a
    // degraded success: three reads at `latest` can straddle a Transfer, so
    // `owner` from before it and `agentWallet` or `tokenURI` from after it
    // land in one document that belongs to no single moment, with no
    // versionId to say so. The spec forbids exactly that document (§10.2),
    // and a caller that gets networkError retries; one that got a quiet
    // document would trust it.
    let blockNumber: bigint;
    try {
      blockNumber = await client.getBlockNumber();
    } catch (err) {
      return this.networkFailure("block number read failed, so the reads could not be pinned", err);
    }

    const contract = { address: parsed.registry, abi: IDENTITY_REGISTRY_ABI, blockNumber } as const;

    let owner: string;
    try {
      owner = (await client.readContract({ ...contract, functionName: "ownerOf", args: [parsed.agentId] })) as string;
    } catch (err) {
      // ERC-721 ownerOf reverts for a token that was never minted or was
      // burned, and that is notFound. A transport failure, a timeout or a
      // rate limit is not: the driver maps notFound to a cacheable 404 and
      // networkError to a 502 that says "retry", and a flaky RPC must not
      // turn into an authoritative "this agent does not exist".
      if (!chainSaidNo(err)) return this.networkFailure("ownerOf could not be read", err);
      return failure("notFound", `agent ${parsed.agentId} does not exist in ${parsed.registry}`);
    }

    let agentWallet: string | undefined;
    try {
      agentWallet = (await client.readContract({ ...contract, functionName: "getAgentWallet", args: [parsed.agentId] })) as string;
    } catch (err) {
      // getAgentWallet is OPTIONAL in ERC-8004, so a revert is the registry
      // saying "not exposed" and the document is complete without it. A
      // transport failure is not that: the wallet may well be there, and a
      // document that silently drops it hands a verifier an assertionMethod
      // with the payment key missing, at a versionId that claims to be whole
      // (spec §4.4). The same split ownerOf makes above, ending in a warning
      // rather than a failure because tokenURI's failure ends that way too:
      // the on-chain identity is still known, one field of it is not (#272).
      agentWallet = undefined;
      if (!chainSaidNo(err)) {
        this.options.onNetworkError?.("getAgentWallet could not be read", err);
        warnings.push({ code: "agentWalletUnavailable", message: "getAgentWallet could not be read" });
      }
    }

    // Whether what the Registration File would have said is known. It is
    // known when there is no file to read (an empty agentURI is a registration
    // made with the no-argument register(), spec §5) and when the file was
    // read and parsed. Anything else leaves `service` and `active` unknown,
    // and the metadata has to say so: a warning alone is easy to skip over,
    // and a missing `deactivated` reads as "active" to a consumer that reads
    // only that field.
    let registrationKnown = true;

    let agentUri = "";
    try {
      agentUri = (await client.readContract({ ...contract, functionName: "tokenURI", args: [parsed.agentId] })) as string;
    } catch {
      warnings.push({ code: "agentUriUnavailable", message: "tokenURI reverted" });
      registrationKnown = false;
    }

    let registration: RegistrationFile | null = null;
    if (agentUri) {
      registrationKnown = false;
      try {
        const fetcher = this.options.fetchAgentUri
          ?? ((u: string) => defaultFetchAgentUri(u, {
            ...(this.options.ipfsGateway !== undefined ? { ipfsGateway: this.options.ipfsGateway } : {}),
            ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
            ...(this.options.maxAgentUriBytes !== undefined ? { maxResponseBytes: this.options.maxAgentUriBytes } : {}),
            ...(this.options.allowedAgentUriHosts !== undefined ? { allowedHosts: this.options.allowedAgentUriHosts } : {}),
          }));
        const doc = await fetcher(agentUri);
        // A JSON array is an object to typeof and a registration file to
        // nothing else: neither `active` nor `services` can be read from it,
        // so it is the "could not be parsed" case of spec §6.1, not a read
        // file (#273).
        if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
          registration = doc as RegistrationFile;
          registrationKnown = true;
        } else {
          warnings.push({ code: "agentUriMalformed", message: "registration file is not a JSON object" });
        }
      } catch (err) {
        // On-chain state is authoritative for identity. An identity that
        // disappears because a gateway is down is not censorship-resistant.
        warnings.push({
          code: err instanceof AgentUriError ? "agentUriUnreachable" : "agentUriError",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const inactive = registration !== null && registration.active === false;

    return {
      didDocument: buildDidDocument({ parsed, owner, agentWallet, registration }),
      didResolutionMetadata: {
        contentType: "application/did+ld+json",
        ...(warnings.length ? { warnings } : {}),
      },
      didDocumentMetadata: {
        versionId: blockNumber.toString(),
        agentRegistry: parsed.agentRegistry,
        ...(inactive ? { deactivated: true, deactivationReason: "registrationInactive" as const } : {}),
        ...(registrationKnown ? {} : { registrationFile: "unavailable" as const }),
      },
    };
  }
}
