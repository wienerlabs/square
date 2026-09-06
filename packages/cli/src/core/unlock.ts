import * as p from "@clack/prompts";
import { decryptKeystore, importPrivateKey, loadKeystore, type Wallet } from "./wallet.js";
import { SquareError } from "./errors.js";
import { c } from "./theme.js";
import { log } from "./logger.js";

const CACHE_TTL_MS = 5 * 60_000;

let cached: Wallet | null = null;
let cachedAt = 0;

export interface UnlockOptions {
  /** Shown in the passphrase prompt, so the user knows what they are signing. */
  prompt?: string | undefined;
}

/**
 * Produce a signer.
 *
 * SQUARE_PRIVATE_KEY exists because acceptance tests and CI have to register
 * an agent without a terminal to type into. It is loud on purpose: a key in an
 * environment variable is a key in the process table and in shell history.
 */
export async function unlockWallet(opts: UnlockOptions = {}): Promise<Wallet> {
  const fromEnv = process.env.SQUARE_PRIVATE_KEY?.trim();
  if (fromEnv) {
    const wallet = importPrivateKey(fromEnv);
    log.warn(`Signing with SQUARE_PRIVATE_KEY (${wallet.address}), not the keystore.`);
    return wallet;
  }

  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  const keystore = await loadKeystore();

  if (!process.stderr.isTTY) {
    throw new SquareError(
      "Cannot prompt for a passphrase outside an interactive terminal",
      undefined,
      "Run this from a TTY, or set SQUARE_PRIVATE_KEY for unattended use.",
    );
  }

  const passphrase = await p.password({
    message: opts.prompt
      ? `${opts.prompt} — passphrase for ${keystore.address}`
      : `Passphrase for ${c.dim(keystore.address)}`,
    mask: "*",
    validate: (v) => (v && v.length > 0 ? undefined : "Passphrase required."),
  });
  if (p.isCancel(passphrase)) {
    p.cancel("Cancelled.");
    throw new SquareError("Unlock cancelled");
  }

  const wallet = await decryptKeystore(keystore, String(passphrase));
  cached = wallet;
  cachedAt = Date.now();
  return wallet;
}

export function lockWallet(): void {
  cached = null;
  cachedAt = 0;
}

/** The address on file, or null when there is no keystore. Never prompts. */
export async function keystoreAddress(): Promise<string | null> {
  try {
    return (await loadKeystore()).address;
  } catch (err) {
    if ((err as { name?: string }).name === "NotFoundError") return null;
    throw err;
  }
}
