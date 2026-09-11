import { getAddress, isAddress, keccak256, stringToHex, zeroAddress, type Address, type Hex, type LocalAccount } from "viem";
import type { ScreeningSource } from "./source.js";

/** The EIP-712 domain ScreeningRegistry signs under; its constructor sets the same two strings. */
export const SCREENING_DOMAIN_NAME = "Square Screening";
export const SCREENING_DOMAIN_VERSION = "1";

export const SCREENING_TYPES = {
  Screening: [
    { name: "subject", type: "address" },
    { name: "sanctioned", type: "bool" },
    { name: "screenedAt", type: "uint64" },
    { name: "source", type: "bytes32" },
    { name: "evidence", type: "bytes32" },
  ],
} as const;

/**
 * How far behind its own clock the screener stamps an answer when the chain's
 * clock is behind it. The registry judges a screening by the chain's clock: it
 * refuses one from the future, and one older than `maxAge`. So the stamp is the
 * later of the chain's latest block time and the screener's clock less this
 * margin. A chain that has run ahead of the wall clock, as anvil does after a
 * time jump, is stamped in its own time and does not see a fresh answer as
 * stale. A chain that trails the wall clock by a second does not see it as from
 * the future. On Arc the two clocks agree and the choice does not matter.
 */
export const CLOCK_SKEW_SECONDS = 5n;
export const MAX_SUBJECTS = 20;

export interface Screening {
  subject: Address;
  sanctioned: boolean;
  screenedAt: bigint;
  source: Hex;
  evidence: Hex;
}

export interface SignedScreening {
  screening: Screening;
  signature: Hex;
}

export interface ScreeningDomain {
  chainId: number;
  registry: Address;
}

/** Why nothing was attested. 400: the request is wrong. 503: the source cannot be trusted right now. */
export class ScreeningRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 503,
  ) {
    super(message);
    this.name = "ScreeningRefused";
  }
}

export function signScreening(signer: LocalAccount, domain: ScreeningDomain, screening: Screening): Promise<Hex> {
  return signer.signTypedData({
    domain: {
      name: SCREENING_DOMAIN_NAME,
      version: SCREENING_DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.registry,
    },
    types: SCREENING_TYPES,
    primaryType: "Screening",
    message: screening,
  });
}

export interface ScreenOptions {
  source: ScreeningSource;
  /**
   * An address with a published designation, asked about in the same request as
   * every subject. A source that does not flag it is empty, broken or changed,
   * and nothing it said about anyone else is signed (decision §6).
   */
  canary: Address;
  signer: LocalAccount;
  domain: ScreeningDomain;
  /** The chain's latest block time. Without it the stamp is the screener's clock alone. */
  chainTime?: () => Promise<bigint>;
}

const wallClock = (): bigint => BigInt(Math.floor(Date.now() / 1000));

function subjectsFrom(input: readonly unknown[], canary: Address): Address[] {
  if (input.length === 0 || input.length > MAX_SUBJECTS) {
    throw new ScreeningRefused(`between 1 and ${MAX_SUBJECTS} addresses per request`, 400);
  }
  const subjects = input.map((value) => {
    if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new ScreeningRefused(`${String(value)} is not an address`, 400);
    }
    return getAddress(value);
  });
  if (new Set(subjects).size !== subjects.length) throw new ScreeningRefused("an address appears twice", 400);
  if (subjects.includes(zeroAddress)) throw new ScreeningRefused("the zero address is not a subject", 400);
  if (subjects.includes(canary)) throw new ScreeningRefused("the canary is not a subject", 400);
  return subjects;
}

/**
 * Screen `input` in one request to the source, check the canary, and sign one
 * screening per subject. Throws `ScreeningRefused` and signs nothing when the
 * request is wrong, the source cannot answer, or the canary comes back clean.
 */
export async function screenAndSign(
  options: ScreenOptions,
  input: readonly unknown[],
): Promise<{ screenings: SignedScreening[]; rawBody: string; sourceMs: number }> {
  const canary = getAddress(options.canary);
  const subjects = subjectsFrom(input, canary);
  let answer;
  // #35 names the cost of screening at release: it adds latency. This is the
  // source's share of it, measured on every request.
  const asked = performance.now();
  try {
    answer = await options.source.screen([canary, ...subjects]);
  } catch (error) {
    throw new ScreeningRefused(
      `the source could not answer, so nothing was attested: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }
  const sourceMs = Math.round(performance.now() - asked);
  if (answer.sanctioned.get(canary) !== true) {
    throw new ScreeningRefused(`the source did not flag the canary ${canary}, so nothing was attested`, 503);
  }
  const byWallClock = wallClock() - CLOCK_SKEW_SECONDS;
  const byChain = options.chainTime ? await options.chainTime() : 0n;
  const screenedAt = byChain > byWallClock ? byChain : byWallClock;
  const source = stringToHex(options.source.id, { size: 32 });
  const evidence = keccak256(stringToHex(answer.rawBody));
  const screenings: SignedScreening[] = [];
  for (const subject of subjects) {
    const screening: Screening = { subject, sanctioned: answer.sanctioned.get(subject) === true, screenedAt, source, evidence };
    screenings.push({ screening, signature: await signScreening(options.signer, options.domain, screening) });
  }
  return { screenings, rawBody: answer.rawBody, sourceMs };
}
