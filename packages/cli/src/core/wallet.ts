import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { paths, ensureRoot } from "./paths.js";
import { ConfigError, NotFoundError, WalletError } from "./errors.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Unchanged from the Solana CLI this was ported from. N = 2^17 costs about a
 * second and 128 MiB per attempt, which is the point: it is the only thing
 * standing between a stolen keystore file and the key inside it.
 */
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, maxmem: 256 * 1024 * 1024 };

/**
 * Version 2 holds a secp256k1 key; version 1 held an Ed25519 Solana keypair.
 * The wrapper is identical, so a v1 file parses cleanly — which is exactly why
 * the version is checked before the schema. Loading a Solana key as an Arc
 * signer would derive a plausible-looking address for a key that can never
 * hold funds on this chain.
 */
const KEYSTORE_VERSION = 2 as const;
const LEGACY_SOLANA_VERSION = 1;

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12;
const SALT_LENGTH = 32;
/** secp256k1 private keys are 32 bytes; the Ed25519 keypairs this replaced were 64. */
const PRIVATE_KEY_LENGTH = 32;
const MIN_PASSPHRASE = 8;

export const KeystoreSchema = z.object({
  version: z.literal(KEYSTORE_VERSION),
  curve: z.literal("secp256k1"),
  /** EIP-55 checksummed. The identity of the wallet on an EVM chain is its address. */
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  algorithm: z.literal(ALGORITHM),
  kdf: z.object({
    name: z.literal("scrypt"),
    salt: z.string(),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLen: z.number().int().positive(),
  }),
  iv: z.string(),
  ciphertext: z.string(),
  authTag: z.string(),
  createdAt: z.string(),
});

export type Keystore = z.infer<typeof KeystoreSchema>;

/**
 * A signer plus the raw key.
 *
 * viem's PrivateKeyAccount deliberately does not expose the key it was built
 * from, and the keystore has to encrypt it, so the two travel together and
 * nothing outside this module and unlock.ts touches `privateKey`.
 */
export interface Wallet {
  privateKey: Hex;
  address: Address;
  account: PrivateKeyAccount;
}

export function walletFromPrivateKey(privateKey: Hex): Wallet {
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    // secp256k1 rejects zero and anything at or above the curve order. Both are
    // 32 valid-looking bytes, so length alone does not catch them.
    throw new WalletError(
      "Not a valid secp256k1 private key",
      "The value is the right length but outside the curve order.",
    );
  }
  return { privateKey, address: account.address, account };
}

export function generateWallet(): Wallet {
  return walletFromPrivateKey(generatePrivateKey());
}

/** Accepts the hex form every EVM tool exports, with or without the 0x prefix. */
export function importPrivateKey(input: string): Wallet {
  const trimmed = input.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new WalletError(
      "Private key is not hexadecimal",
      "Expected 64 hex characters, optionally prefixed with 0x.",
    );
  }
  if (body.length !== PRIVATE_KEY_LENGTH * 2) {
    throw new WalletError(
      `Private key must be ${PRIVATE_KEY_LENGTH} bytes (got ${Math.floor(body.length / 2)})`,
      "Expected 64 hex characters, optionally prefixed with 0x.",
    );
  }
  return walletFromPrivateKey(`0x${body.toLowerCase()}` as Hex);
}

export async function encryptKeystore(wallet: Wallet, passphrase: string): Promise<Keystore> {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new WalletError(
      `Passphrase must be at least ${MIN_PASSPHRASE} characters`,
      "Pick something memorable but hard to guess.",
    );
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(passphrase, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(wallet.privateKey.slice(2), "hex");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    version: KEYSTORE_VERSION,
    curve: "secp256k1",
    address: wallet.address,
    algorithm: ALGORITHM,
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64"),
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keyLen: SCRYPT_PARAMS.keyLen,
    },
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptKeystore(keystore: Keystore, passphrase: string): Promise<Wallet> {
  const key = await scrypt(passphrase, Buffer.from(keystore.kdf.salt, "base64"), keystore.kdf.keyLen, {
    N: keystore.kdf.N,
    r: keystore.kdf.r,
    p: keystore.kdf.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(keystore.iv, "base64"));
  decipher.setAuthTag(Buffer.from(keystore.authTag, "base64"));

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(keystore.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    // GCM cannot tell a wrong passphrase from an edited file: both fail the tag.
    throw new WalletError(
      "Could not decrypt keystore",
      "The passphrase is wrong, or the keystore file has been tampered with.",
    );
  }
  if (plaintext.length !== PRIVATE_KEY_LENGTH) {
    throw new WalletError("Decrypted private key has unexpected length");
  }

  const wallet = walletFromPrivateKey(`0x${plaintext.toString("hex")}` as Hex);

  // The address is outside the AEAD, so it is attacker-controlled even when the
  // ciphertext is intact. Checking it here stops a swapped address from being
  // reported as the signer of a transaction the real key went on to sign.
  if (getAddress(wallet.address) !== getAddress(keystore.address)) {
    throw new WalletError(
      "Keystore address does not match the key it holds",
      "The file has been edited. Restore it from your backup.",
    );
  }
  return wallet;
}

export async function loadKeystore(): Promise<Keystore> {
  let raw: string;
  try {
    raw = await readFile(paths.keystoreFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(
        "Not logged in",
        "Run 'mandate login' to create or import a wallet.",
      );
    }
    throw new ConfigError(`Could not read ${paths.keystoreFile()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `Keystore at ${paths.keystoreFile()} is not valid JSON`,
      "Restore it from your backup, or delete it and run 'mandate login' again.",
    );
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { version?: unknown }).version === LEGACY_SOLANA_VERSION
  ) {
    throw new WalletError(
      "This keystore holds a Solana (Ed25519) key from the aip CLI",
      "Mandate signs secp256k1 transactions on Arc. Create a new wallet with " +
        "'mandate login', or import an EVM key with 'mandate login --import-key'.",
    );
  }

  const result = KeystoreSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Keystore at ${paths.keystoreFile()} is malformed`,
      "Restore it from your backup, or delete it and run 'mandate login' again.",
    );
  }
  return result.data;
}

export async function saveKeystore(keystore: Keystore): Promise<void> {
  await ensureRoot();
  const target = paths.keystoreFile();
  // Written to a temporary name and renamed: a crash mid-write must not leave a
  // half-file where the only copy of a key used to be.
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

export async function deleteKeystore(): Promise<void> {
  try {
    await unlink(paths.keystoreFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function keystoreExists(): Promise<boolean> {
  try {
    await readFile(paths.keystoreFile(), "utf8");
    return true;
  } catch {
    return false;
  }
}
