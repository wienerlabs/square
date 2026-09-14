import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * An institution's own API key, at rest.
 *
 * AES-256-GCM, the key derived from the operator's secret with HKDF and
 * the ciphertext bound to the agent it was sealed for: a sealed value
 * copied from one agent's configuration into another's does not open.
 * The predecessor hashed the secret straight into a key and told sealed
 * from plain text by whether base64 decoded; the format here says what it
 * is, so a plain key in a field that wants a sealed one is an error, not a
 * guess.
 *
 *   sealed:v1:<base64url(iv || tag || ciphertext)>
 */
export const SEALED_PREFIX = "sealed:v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_SALT = "square-hosted";
const HKDF_INFO = "api-key-seal-v1";

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** The 32-byte key an operator's secret derives to. The secret itself is never the key. */
export function deriveSealKey(secret: string): Buffer {
  if (secret.length < 16) throw new SealError("the seal secret must be at least 16 characters");
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

/** `context` names what the value belongs to (`hosted-agent:<agentId>`); it must be given again to open. */
export function seal(plaintext: string, key: Buffer, context: string): string {
  if (key.length !== KEY_LENGTH) throw new SealError(`the seal key must be ${KEY_LENGTH} bytes`);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

export function open(sealed: string, key: Buffer, context: string): string {
  if (!isSealed(sealed)) throw new SealError("not a sealed value: expected the sealed:v1: prefix");
  if (key.length !== KEY_LENGTH) throw new SealError(`the seal key must be ${KEY_LENGTH} bytes`);
  const bytes = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64url");
  if (bytes.length < IV_LENGTH + TAG_LENGTH) throw new SealError("sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_LENGTH));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
  } catch {
    // Node reports every GCM failure the same way, and the honest answer is
    // the same too: wrong key, wrong agent, or a byte that changed.
    throw new SealError("the sealed value does not open with this key for this agent");
  }
}
